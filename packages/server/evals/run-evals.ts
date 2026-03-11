import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applySchema } from "../src/db/schema.js";
import { buildQueries } from "../src/db/queries.js";
import { buildGroundedAnswer } from "../src/tools/answer-question.js";
import { verifyGroundedAnswer } from "../src/lib/answer-verifier.js";

interface EvalCase {
  question: string;
  expectedSlugs: string[];
  shouldAbstain: boolean;
}

interface EvalResult {
  hitAtK: number;
  citationPrecision: number;
  unsupportedClaimRate: number;
  abstainCorrect: number;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(__dirname, "golden-set.jsonl");
const TOP_K = 6;

const THRESHOLDS = {
  hitAtK: 0.8,
  citationPrecision: 0.6,
  unsupportedClaimRateMax: 0.2,
  abstainAccuracy: 1.0,
};

function parseGoldenSet(): EvalCase[] {
  const raw = readFileSync(GOLDEN_PATH, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EvalCase);
}

function seedFixtureDocs(db: Database.Database): void {
  const insert = db.prepare(`
    INSERT INTO documents
      (url, slug, title, doc_type, source, category, signature, since_version,
       parent_id, content_markdown, content_plain, functions_mentioned, hooks_mentioned, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const rows: Array<[string, string, string, string, string, string | null, string | null, string | null, number | null, string, string, string | null, string | null, string | null]> = [
    [
      "https://developer.wordpress.org/reference/functions/wp_enqueue_script/",
      "wp_enqueue_script",
      "wp_enqueue_script",
      "function",
      "devhub-api",
      "code-reference",
      "wp_enqueue_script( $handle, $src, $deps, $ver, $in_footer )",
      "2.1.0",
      null,
      "Use wp_enqueue_script to register and enqueue JavaScript files in themes and plugins.",
      "Use wp_enqueue_script to register and enqueue JavaScript files in themes and plugins.",
      null,
      null,
      null,
    ],
    [
      "https://developer.wordpress.org/reference/hooks/save_post/",
      "save_post",
      "save_post",
      "hook",
      "devhub-api",
      "code-reference",
      "do_action( 'save_post', $post_id, $post, $update )",
      "1.5.0",
      null,
      "The save_post action fires once a post has been saved.",
      "The save_post action fires once a post has been saved.",
      null,
      null,
      null,
    ],
    [
      "https://developer.wordpress.org/reference/functions/register_post_type/",
      "register_post_type",
      "register_post_type",
      "function",
      "devhub-api",
      "code-reference",
      "register_post_type( $post_type, $args )",
      "3.0.0",
      null,
      "Use register_post_type during init to register custom post types.",
      "Use register_post_type during init to register custom post types.",
      null,
      null,
      null,
    ],
    [
      "https://developer.wordpress.org/reference/functions/wp_verify_nonce/",
      "wp_verify_nonce",
      "wp_verify_nonce",
      "function",
      "devhub-api",
      "code-reference",
      "wp_verify_nonce( $nonce, $action )",
      "2.0.3",
      null,
      "wp_verify_nonce verifies that a nonce is valid for a specific action.",
      "wp_verify_nonce verifies that a nonce is valid for a specific action.",
      null,
      null,
      null,
    ],
    [
      "https://developer.wordpress.org/reference/functions/check_admin_referer/",
      "check_admin_referer",
      "check_admin_referer",
      "function",
      "devhub-api",
      "code-reference",
      "check_admin_referer( $action, $query_arg )",
      "1.2.0",
      null,
      "check_admin_referer validates admin request nonce and referer.",
      "check_admin_referer validates admin request nonce and referer.",
      null,
      null,
      null,
    ],
    [
      "https://developer.wordpress.org/reference/functions/register_rest_route/",
      "register_rest_route",
      "register_rest_route",
      "function",
      "devhub-api",
      "rest-api",
      "register_rest_route( $namespace, $route, $args, $override )",
      "4.4.0",
      null,
      "register_rest_route registers custom REST API routes.",
      "register_rest_route registers custom REST API routes.",
      null,
      null,
      null,
    ],
  ];

  const tx = db.transaction(() => {
    for (const row of rows) insert.run(...row);
  });
  tx();
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

async function main(): Promise<void> {
  const evalCases = parseGoldenSet();

  const db = new Database(":memory:");
  applySchema(db);
  seedFixtureDocs(db);
  const queries = buildQueries(db);

  const results: EvalResult[] = [];

  for (const testCase of evalCases) {
    const answerResult = await buildGroundedAnswer(queries, {
      question: testCase.question,
      top_k: TOP_K,
    });
    const verification = verifyGroundedAnswer(answerResult.answer, queries);
    const evidenceSlugs = new Set(answerResult.evidence.map((e) => e.slug));

    const expectedSet = new Set(testCase.expectedSlugs);
    const hitAtK =
      expectedSet.size === 0
        ? 1
        : [...expectedSet].some((slug) => evidenceSlugs.has(slug))
          ? 1
          : 0;

    const citations = answerResult.answer.citations;
    const citationsInExpected =
      citations.length === 0
        ? 0
        : citations.filter((c) => expectedSet.has(c.slug)).length / citations.length;
    const citationPrecision =
      expectedSet.size === 0 && citations.length === 0 ? 1 : citationsInExpected;

    const abstainCorrect = answerResult.answer.abstained === testCase.shouldAbstain ? 1 : 0;

    results.push({
      hitAtK,
      citationPrecision,
      unsupportedClaimRate: verification.unsupportedClaimRate,
      abstainCorrect,
    });
  }

  const metrics = {
    hitAtK: average(results.map((r) => r.hitAtK)),
    citationPrecision: average(results.map((r) => r.citationPrecision)),
    unsupportedClaimRate: average(results.map((r) => r.unsupportedClaimRate)),
    abstainAccuracy: average(results.map((r) => r.abstainCorrect)),
  };

  console.log("[eval] Metrics:", JSON.stringify(metrics, null, 2));

  const failures: string[] = [];
  if (metrics.hitAtK < THRESHOLDS.hitAtK) {
    failures.push(
      `hit@k ${metrics.hitAtK.toFixed(2)} below threshold ${THRESHOLDS.hitAtK.toFixed(2)}`
    );
  }
  if (metrics.citationPrecision < THRESHOLDS.citationPrecision) {
    failures.push(
      `citation precision ${metrics.citationPrecision.toFixed(2)} below threshold ${THRESHOLDS.citationPrecision.toFixed(2)}`
    );
  }
  if (metrics.unsupportedClaimRate > THRESHOLDS.unsupportedClaimRateMax) {
    failures.push(
      `unsupported claim rate ${metrics.unsupportedClaimRate.toFixed(2)} above threshold ${THRESHOLDS.unsupportedClaimRateMax.toFixed(2)}`
    );
  }
  if (metrics.abstainAccuracy < THRESHOLDS.abstainAccuracy) {
    failures.push(
      `abstain accuracy ${metrics.abstainAccuracy.toFixed(2)} below threshold ${THRESHOLDS.abstainAccuracy.toFixed(2)}`
    );
  }

  db.close();

  if (failures.length > 0) {
    console.error("[eval] Quality gate failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("[eval] Quality gate passed.");
}

void main();
