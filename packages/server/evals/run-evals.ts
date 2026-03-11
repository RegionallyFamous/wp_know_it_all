import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applySchema } from "../src/db/schema.js";
import { buildQueries } from "../src/db/queries.js";
import { buildGroundedAnswer, formatGroundedAnswerOutput } from "../src/tools/answer-question.js";
import { verifyGroundedAnswer } from "../src/lib/answer-verifier.js";
import { hasWranglerStyle } from "../src/lib/persona.js";

interface EvalCase {
  question: string;
  expectedSlugs: string[];
  shouldAbstain: boolean;
}

interface EvalResult {
  hitAtK: number;
  citationPrecision: number;
  unsupportedClaimRate: number;
  averageSupportScore: number;
  abstainCorrect: number;
  styleConformance: number;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(__dirname, "golden-set.jsonl");
const TOP_K = 6;

const PROFILE = (process.env["EVAL_PROFILE"] ?? "default").toLowerCase();
const THRESHOLDS =
  PROFILE === "canary"
    ? {
        hitAtK: 0.95,
        citationPrecision: 0.62,
        unsupportedClaimRateMax: 0.08,
        averageSupportScore: 0.72,
        abstainAccuracy: 0.75,
        styleConformance: 1.0,
      }
    : {
        hitAtK: 0.9,
        citationPrecision: 0.62,
        unsupportedClaimRateMax: 0.12,
        averageSupportScore: 0.62,
        abstainAccuracy: 0.75,
        styleConformance: 1.0,
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
    [
      "https://github.com/WordPress/playground/blob/trunk/docs/blueprints.md",
      "wp-github-playground-blueprints",
      "WordPress Playground Blueprints",
      "guide",
      "wordpress-github-docs",
      "common-apis",
      null,
      null,
      null,
      "Blueprints define a declarative setup for Playground sites, including plugins, themes, and content steps.",
      "Blueprints define a declarative setup for Playground sites, including plugins, themes, and content steps.",
      null,
      null,
      "{\"repo\":\"https://github.com/WordPress/playground.git\",\"path\":\"docs/blueprints.md\"}",
    ],
    [
      "https://github.com/WordPress/wordpress-develop/blob/trunk/README.md",
      "wp-github-wordpress-develop-readme",
      "WordPress Develop README",
      "guide",
      "wordpress-github-code",
      "code-reference",
      null,
      null,
      null,
      "The wordpress-develop repository includes local setup guidance for contributing patches and running tests.",
      "The wordpress-develop repository includes local setup guidance for contributing patches and running tests.",
      null,
      null,
      "{\"repo\":\"https://github.com/WordPress/wordpress-develop.git\",\"path\":\"README.md\"}",
    ],
    [
      "https://www.rfc-editor.org/rfc/rfc9110.txt",
      "ietf-rfc-rfc-9110-http-semantics",
      "RFC 9110: HTTP Semantics",
      "guide",
      "ietf-rfcs",
      "software-engineering",
      null,
      null,
      null,
      "RFC 9110 defines HTTP semantics, methods, status codes, and content negotiation.",
      "RFC 9110 defines HTTP semantics, methods, status codes, and content negotiation.",
      null,
      null,
      null,
    ],
    [
      "https://docs.python.org/3/library/urllib.parse.html",
      "python-library-urllib-parse",
      "urllib.parse",
      "guide",
      "python-docs",
      "python-runtime",
      null,
      null,
      null,
      "urllib.parse provides URL parsing and joining functions such as urlparse and urljoin.",
      "urllib.parse provides URL parsing and joining functions such as urlparse and urljoin.",
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
    const rendered = formatGroundedAnswerOutput(answerResult.answer, verification);
    const styleConformance = hasWranglerStyle(rendered) ? 1 : 0;

    results.push({
      hitAtK,
      citationPrecision,
      unsupportedClaimRate: verification.unsupportedClaimRate,
      averageSupportScore: verification.averageSupportScore,
      abstainCorrect,
      styleConformance,
    });
  }

  const metrics = {
    hitAtK: average(results.map((r) => r.hitAtK)),
    citationPrecision: average(results.map((r) => r.citationPrecision)),
    unsupportedClaimRate: average(results.map((r) => r.unsupportedClaimRate)),
    averageSupportScore: average(results.map((r) => r.averageSupportScore)),
    abstainAccuracy: average(results.map((r) => r.abstainCorrect)),
    styleConformance: average(results.map((r) => r.styleConformance)),
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
  if (metrics.averageSupportScore < THRESHOLDS.averageSupportScore) {
    failures.push(
      `average support score ${metrics.averageSupportScore.toFixed(2)} below threshold ${THRESHOLDS.averageSupportScore.toFixed(2)}`
    );
  }
  if (metrics.abstainAccuracy < THRESHOLDS.abstainAccuracy) {
    failures.push(
      `abstain accuracy ${metrics.abstainAccuracy.toFixed(2)} below threshold ${THRESHOLDS.abstainAccuracy.toFixed(2)}`
    );
  }
  if (metrics.styleConformance < THRESHOLDS.styleConformance) {
    failures.push(
      `style conformance ${metrics.styleConformance.toFixed(2)} below threshold ${THRESHOLDS.styleConformance.toFixed(2)}`
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
