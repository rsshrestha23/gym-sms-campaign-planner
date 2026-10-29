export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://gym:gym@localhost:5433/gym',
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
};
