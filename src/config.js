import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const config = {
  lab: path.resolve(process.env.OPENETL_LAB || path.join(root, '../openetl-data-lab')),
  repo: path.resolve(process.env.OPENETL_REPO || path.join(root, '../openetl')),
  allowedContainers: [
    'openetl-lab-postgres',
    'openetl-lab-mongodb',
    'openetl-lab-clickhouse',
    'openetl-lab-elasticsearch',
    'openetl-lab-qdrant',
  ],
  pg: { container: 'openetl-lab-postgres', user: 'lab', db: 'openetl' },
  port: 4100,
};

export const { lab, repo, allowedContainers, pg, port } = config;
export default config;
