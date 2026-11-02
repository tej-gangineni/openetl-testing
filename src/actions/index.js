import { dropTable, scalar, rows } from './pg.js';
import { countFiles, listFiles, countCsvRows } from './fs.js';
import { jobRun, jobStart, jobWait } from './openetl.js';
import { compare, missing } from './check.js';
import { chScalar, chRows, chDropTable } from './ch.js';
import { esCount, esSearch, esDropIndex, esDistinct } from './es.js';
import { relataQuery } from './relata.js';
import { dockerStop, dockerStart } from './docker.js';
import { sleep } from './wait.js';
import { stage } from './fixture.js';
import mongo from './mongo.js';
import qdrant from './qdrant.js';
import s06 from './s06.js';
import s10 from './s10.js';

export default {
  'pg.dropTable': dropTable,
  'pg.scalar': scalar,
  'pg.rows': rows,
  'fs.countFiles': countFiles,
  'openetl.jobRun': jobRun,
  'openetl.jobStart': jobStart,
  'openetl.jobWait': jobWait,
  'fs.list': listFiles,
  'fs.countCsvRows': countCsvRows,
  'check.compare': compare,
  'check.missing': missing,
  'ch.scalar': chScalar,
  'ch.rows': chRows,
  'ch.dropTable': chDropTable,
  'es.count': esCount,
  'es.search': esSearch,
  'es.dropIndex': esDropIndex,
  'es.distinct': esDistinct,
  'relata.query': relataQuery,
  'docker.stop': dockerStop,
  'docker.start': dockerStart,
  'wait.sleep': sleep,
  'fixture.stage': stage,
  ...mongo,
  ...qdrant,
  ...s06,
  ...s10,
};
