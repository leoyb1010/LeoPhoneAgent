import {
  acquireSchemaMigrationReaderLease,
  acquireSchemaMigrationWriterLease,
} from '../../schemaMigrationLease';

const [dbFilePath, kind] = process.argv.slice(2);
if (!dbFilePath || (kind !== 'reader' && kind !== 'writer')) {
  throw new Error('usage: schemaLeaseChild <db-path> <reader|writer>');
}

const result =
  kind === 'reader'
    ? acquireSchemaMigrationReaderLease(dbFilePath)
    : acquireSchemaMigrationWriterLease(dbFilePath);
if (!result.acquired) {
  process.send?.({ type: 'failed', reason: result.reason });
  process.exit(2);
}

process.send?.({ type: 'ready', kind });
process.on('message', (message) => {
  if (message !== 'release') return;
  result.lease.release();
  process.exit(0);
});
setInterval(() => undefined, 60_000);
