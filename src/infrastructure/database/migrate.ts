import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from './mikro-orm.config.js';

const orm = await MikroORM.init(mikroOrmConfig);

try {
  const migrations = await orm.migrator.up();
  console.log(`Applied ${migrations.length} migration(s).`);
} finally {
  await orm.close(true);
}
