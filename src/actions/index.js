import { dropTable, scalar, rows } from './pg.js';
import { countFiles } from './fs.js';
import { jobRun } from './openetl.js';
import { compare } from './check.js';

export default {
  'pg.dropTable': dropTable,
  'pg.scalar': scalar,
  'pg.rows': rows,
  'fs.countFiles': countFiles,
  'openetl.jobRun': jobRun,
  'check.compare': compare,
};
