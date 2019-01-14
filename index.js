const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { PassThrough } = require('stream');
const S3 = require('aws-sdk/clients/s3');
const csv = require('fast-csv');
const mysql = require('mysql');
const yazl = require('yazl');
const config = require('./config');
const { hash, logProgress, mkDirByPathSync } = require('./helpers');

const TSV_OPTIONS = { headers: true, delimiter: '\t', quote: null };
const OUT_DIR = 'out';

const { accessKeyId, secretAccessKey, name: outBucketName } = config.get(
  'outBucket'
);

const { host, user, password, database } = config.get('db');
const db = mysql.createConnection({
  host,
  user,
  password,
  database
});
db.connect();

const outBucket = new S3({
  credentials: {
    accessKeyId,
    secretAccessKey
  },
  region: 'us-west-2'
});
const releaseDir = 'cv-corpus-' + new Date().toISOString();

const createAndUploadClipsTSVArchive = () => {
  const archive = new yazl.ZipFile();

  const tsvPassThrough = new PassThrough();
  archive.addReadStream(tsvPassThrough, 'clips.tsv');

  const archivePassThrough = new PassThrough();
  archive.outputStream.pipe(archivePassThrough);

  archive.end();

  const managedUpload = outBucket.upload({
    Body: archivePassThrough,
    Bucket: 'common-voice-data-download',
    Key: `${releaseDir}/clips.tsv.zip`
  });

  const tsvStream = csv.createWriteStream(TSV_OPTIONS);
  tsvStream.pipe(tsvPassThrough);

  return [tsvStream, managedUpload.promise()];
};

const getClipFile = path => {
  const { accessKeyId, secretAccessKey, name, region } = config.get(
    'clipBucket'
  );
  return new S3({
    credentials: {
      accessKeyId,
      secretAccessKey
    },
    region
  }).getObject({
    Bucket: name,
    Key: path
  });
};

const downloadClips = () => {
  return new Promise(resolve => {
    let activeDownloads = 0;
    let rowIndex = 0;
    let clipSavedIndex = 0;
    const renderProgress = () => {
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(
        rowIndex + ' rows processed, ' + clipSavedIndex + ' clips downloaded'
      );
    };

    const [tsvStream, tsvUploadPromise] = createAndUploadClipsTSVArchive();

    let readAllRows = false;
    const cleanUp = () => {
      if (readAllRows && activeDownloads == 0) {
        db.end();
        console.log('');
        tsvUploadPromise.then(resolve);
      }
    };

    db.query(fs.readFileSync(path.join(__dirname, 'query.sql'), 'utf-8'))
      .on('result', row => {
        rowIndex++;
        renderProgress();

        const newPath = hash(row.path);
        tsvStream.write({
          ...row,
          client_id: hash(row.client_id),
          path: newPath
        });

        const fileDir = path.join(OUT_DIR, row.locale);
        const soundFilePath = path.join(fileDir, newPath + '.mp3');

        if (fs.existsSync(soundFilePath)) {
          return;
        }

        if (activeDownloads > 50) {
          db.pause();
        }

        activeDownloads++;

        mkDirByPathSync(fileDir);
        getClipFile(row.path)
          .createReadStream()
          .pipe(fs.createWriteStream(soundFilePath))
          .on('finish', () => {
            activeDownloads--;
            if (activeDownloads < 25) {
              db.resume();
            }

            clipSavedIndex++;
            renderProgress();

            cleanUp();
          });
      })
      .on('end', () => {
        readAllRows = true;
        tsvStream.end();
        cleanUp();
      });
  });
};

const bundleClips = () => {
  const dirs = fs
    .readdirSync(OUT_DIR)
    .filter(f => fs.statSync(path.join(OUT_DIR, f)).isDirectory());

  return dirs.reduce((promise, locale) => {
    return promise.then(() => {
      console.log('archiving & uploading', locale);

      const stream = new PassThrough();
      const managedUpload = outBucket.upload({
        Body: stream,
        Bucket: outBucketName,
        Key: `${releaseDir}/${locale}.zip`
      });
      logProgress(managedUpload);

      const archive = new yazl.ZipFile();
      const localeDir = path.join(OUT_DIR, locale);
      for (const file of fs.readdirSync(localeDir)) {
        archive.addFile(path.join(localeDir, file), file);
      }
      archive.outputStream.pipe(stream);
      archive.end();

      return managedUpload
        .promise()
        .then(() => console.log(''))
        .catch(err => console.error(err));
    });
  }, Promise.resolve());
};

downloadClips()
  .then(bundleClips)
  .catch(e => console.error(e));