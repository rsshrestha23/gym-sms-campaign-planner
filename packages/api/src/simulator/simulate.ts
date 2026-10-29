import { generateBatch, DEFAULT_SEED } from './events';
import { dispatchEvents, fetchPlannedSends } from './provider-client';

export interface SimulateOptions {
  baseUrl: string;
  campaignId: number;
  concurrency: number;
  ratePerSecond?: number;
  seed: number;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SimulateOptions {
  const options: SimulateOptions = {
    baseUrl: env.API_BASE_URL ?? 'http://localhost:3000',
    campaignId: 1,
    concurrency: 50,
    seed: DEFAULT_SEED,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.split('=', 2);
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${flag}`);
      return v;
    };
    const positive = (v: string) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number`);
      return n;
    };
    switch (flag) {
      case '--rate':
        options.ratePerSecond = positive(value());
        break;
      case '--concurrency':
        options.concurrency = Math.floor(positive(value()));
        break;
      case '--campaign':
        options.campaignId = Math.floor(positive(value()));
        break;
      case '--seed':
        options.seed = Math.floor(positive(value()));
        break;
      case '--base-url':
        options.baseUrl = value();
        break;
      default:
        throw new Error(`Unknown argument ${arg}`);
    }
  }
  return options;
}

export async function simulate(options: SimulateOptions, log: (line: string) => void = console.log) {
  const sends = await fetchPlannedSends(options.baseUrl, options.campaignId);
  const batch = generateBatch(sends, options.seed);
  log(
    `Campaign ${options.campaignId}: ${sends.length} planned sends -> ${batch.events.length} events, ` +
      `${batch.requests.length} requests (delivered ${batch.outcomes.delivered}, ` +
      `undelivered ${batch.outcomes.undelivered}, failed ${batch.outcomes.failed})`,
  );
  log(
    `Posting to ${options.baseUrl}/webhooks/provider with ${options.concurrency} in flight` +
      (options.ratePerSecond ? `, at most ${options.ratePerSecond} req/s` : ''),
  );

  let lastLogged = 0;
  const report = await dispatchEvents(options.baseUrl, batch.requests, {
    concurrency: options.concurrency,
    ratePerSecond: options.ratePerSecond,
    onProgress: (done, total) => {
      const now = Date.now();
      if (now - lastLogged > 1000 || done === total) {
        lastLogged = now;
        log(`  ${done}/${total}`);
      }
    },
  });
  log(
    `Done in ${(report.elapsedMs / 1000).toFixed(1)}s: attempted ${report.attempted}, applied ${report.applied}, ` +
      `duplicate ${report.duplicate}, ignored ${report.ignored}, rejected ${report.rejected}, ` +
      `error ${report.error}, max in flight ${report.maxInFlight}`,
  );
  return { sends, batch, report };
}

if (require.main === module) {
  simulate(parseArgs(process.argv.slice(2)))
    .then(({ report }) => process.exit(report.error > 0 || report.rejected > 0 ? 1 : 0))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
