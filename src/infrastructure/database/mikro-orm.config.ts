import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';

export default defineConfig({
  clientUrl:
    process.env.DATABASE_URL ??
    'postgresql://jungle:jungle_dev_password@localhost:5432/jungle',
  entities: [],
  metadataProvider: ReflectMetadataProvider,
  discovery: {
    warnWhenNoEntities: false,
  },
  extensions: [Migrator],
  migrations: {
    path: './dist/migrations',
    pathTs: './src/migrations',
    emit: 'ts',
  },
});
