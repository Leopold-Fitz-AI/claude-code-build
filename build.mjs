#!/usr/bin/env node
/**
 * Build script for Claude Code from source.
 *
 * Usage:
 *   node build.mjs                  # Build with default settings
 *   node build.mjs --outfile=out.js # Custom output file
 *   node build.mjs --minify         # Minify output
 *   node build.mjs --sourcemap      # Generate source map
 *
 * This replaces the internal Bun-based build pipeline with esbuild,
 * shimming `bun:bundle` feature() and injecting MACRO.* constants.
 */

import esbuild from 'esbuild';
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');

// ── Parse CLI flags ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name) => {
  const a = args.find((a) => a.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
};
const hasFlag = (name) => args.includes(`--${name}`);

const outfile = getArg('outfile') || 'cli.built.js';
const doMinify = hasFlag('minify');
const doSourcemap = hasFlag('sourcemap');

// ── Read package version ─────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const VERSION = pkg.version || '2.1.88';

// ── Feature flags ────────────────────────────────────────────────────
// In the official build, these are set per build variant.
// For a standard CLI build, most internal/experimental features are off.
// Features whose source directories are missing MUST remain false.
const FEATURE_FLAGS = {
  ABLATION_BASELINE: false,
  AGENT_MEMORY_SNAPSHOT: false,
  AGENT_TRIGGERS: false,
  AGENT_TRIGGERS_REMOTE: false,
  ALLOW_TEST_VERSIONS: false,
  ANTI_DISTILLATION_CC: false,
  AUTO_THEME: true,
  AWAY_SUMMARY: false,
  BASH_CLASSIFIER: false,
  BG_SESSIONS: false,         // src/cli/bg.ts missing
  BREAK_CACHE_COMMAND: false,
  BRIDGE_MODE: false,         // imports bridge modules
  BUDDY: false,
  BUILDING_CLAUDE_APPS: true,
  BUILTIN_EXPLORE_PLAN_AGENTS: true,
  BYOC_ENVIRONMENT_RUNNER: false,  // src/environment-runner/ missing
  CACHED_MICROCOMPACT: false,
  CCR_AUTO_CONNECT: false,
  CCR_MIRROR: false,
  CCR_REMOTE_SETUP: false,
  CHICAGO_MCP: false,         // requires @ant/computer-use-mcp
  COMMIT_ATTRIBUTION: true,
  COMPACTION_REMINDERS: true,
  CONNECTOR_TEXT: false,
  CONTEXT_COLLAPSE: false,
  COORDINATOR_MODE: false,
  COWORKER_TYPE_TELEMETRY: false,
  DAEMON: false,              // src/daemon/ missing
  DIRECT_CONNECT: false,
  DOWNLOAD_USER_SETTINGS: false,
  DUMP_SYSTEM_PROMPT: false,
  ENHANCED_TELEMETRY_BETA: false,
  EXPERIMENTAL_SKILL_SEARCH: false,
  EXTRACT_MEMORIES: true,
  FILE_PERSISTENCE: false,
  FORK_SUBAGENT: false,
  HARD_FAIL: false,
  HISTORY_PICKER: false,
  HISTORY_SNIP: false,
  HOOK_PROMPTS: true,
  IS_LIBC_GLIBC: false,
  IS_LIBC_MUSL: false,
  KAIROS: false,
  KAIROS_BRIEF: false,
  KAIROS_CHANNELS: false,
  KAIROS_DREAM: false,
  KAIROS_GITHUB_WEBHOOKS: false,
  KAIROS_PUSH_NOTIFICATION: false,
  LODESTONE: false,
  MCP_RICH_OUTPUT: true,
  MCP_SKILLS: true,
  MEMORY_SHAPE_TELEMETRY: false,
  MESSAGE_ACTIONS: false,
  MONITOR_TOOL: false,
  NATIVE_CLIENT_ATTESTATION: false,
  NATIVE_CLIPBOARD_IMAGE: false,
  NEW_INIT: false,
  OVERFLOW_TEST_TOOL: false,
  PERFETTO_TRACING: false,
  POWERSHELL_AUTO_MODE: false,
  PROMPT_CACHE_BREAK_DETECTION: false,
  QUICK_SEARCH: false,
  REACTIVE_COMPACT: false,
  REVIEW_ARTIFACT: false,
  RUN_SKILL_GENERATOR: false,
  SELF_HOSTED_RUNNER: false,  // src/self-hosted-runner/ missing
  SHOT_STATS: false,
  SKILL_IMPROVEMENT: false,
  SLOW_OPERATION_LOGGING: false,
  SSH_REMOTE: false,
  STREAMLINED_OUTPUT: false,
  TEAMMEM: false,
  TEMPLATES: false,           // src/cli/handlers/templateJobs.ts missing
  TERMINAL_PANEL: false,
  TOKEN_BUDGET: false,
  TORCH: false,
  TRANSCRIPT_CLASSIFIER: false,
  TREE_SITTER_BASH: false,
  TREE_SITTER_BASH_SHADOW: false,
  UDS_INBOX: false,
  ULTRAPLAN: false,
  ULTRATHINK: false,
  UNATTENDED_RETRY: false,
  UPLOAD_USER_SETTINGS: false,
  VERIFICATION_AGENT: false,
  VOICE_MODE: false,
  WEB_BROWSER_TOOL: false,
  WORKFLOW_SCRIPTS: false,
};

// ── MACRO definitions (build-time constants) ─────────────────────────
const MACROS = {
  'MACRO.VERSION': JSON.stringify(VERSION),
  'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
  'MACRO.PACKAGE_URL': JSON.stringify('@anthropic-ai/claude-code'),
  'MACRO.NATIVE_PACKAGE_URL': JSON.stringify(null),
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify('https://github.com/anthropics/claude-code/issues'),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify(
    'report the issue at https://github.com/anthropics/claude-code/issues'
  ),
  'MACRO.VERSION_CHANGELOG': JSON.stringify(''),
  'MACRO.MACRO_VERSION': JSON.stringify(VERSION),
};

// ── Modules that are missing from the npm distribution ───────────────
// These are feature-gated internal modules. Even though their feature
// flags are false, esbuild may still encounter them in dynamic imports.
// We stub them out to avoid build errors.
const MISSING_MODULES = [
  // Directories not in npm package
  '../daemon/',
  '../environment-runner/',
  '../self-hosted-runner/',
  '../cli/bg',
  '../cli/handlers/templateJobs',
];

// Private/internal packages that are not on public npm
const PRIVATE_PACKAGES = [
  '@ant/',
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/mcpb',
  '@anthropic-ai/sandbox-runtime',
  'color-diff-napi',
];

// ── Named exports for stubbed modules ────────────────────────────────
// When a module is stubbed, esbuild requires named imports to exist.
// These are collected from build errors for modules that are feature-gated
// or not included in the npm distribution.
const STUB_NAMED_EXPORTS = {
  // @ant internal packages
  '@ant/computer-use-mcp': ['buildComputerUseTools', 'createComputerUseMcpServer', 'bindSessionContext', 'DEFAULT_GRANT_FLAGS', 'API_RESIZE_PARAMS', 'targetImageSize'],
  '@ant/computer-use-mcp/sentinelApps': ['getSentinelCategory'],
  '@ant/computer-use-mcp/types': ['DEFAULT_GRANT_FLAGS'],
  '@ant/claude-for-chrome-mcp': ['createClaudeForChromeMcpServer', 'BROWSER_TOOLS', 'CHROME_TOOL_NAMES'],
  '@ant/computer-use-input': [],
  '@ant/computer-use-swift': [],
  '@anthropic-ai/sandbox-runtime': ['SandboxManager', 'SandboxRuntimeConfigSchema', 'SandboxViolationStore'],
  '@anthropic-ai/claude-agent-sdk': [],
  '@anthropic-ai/mcpb': [],
  'color-diff-napi': ['ColorDiff', 'ColorFile', 'getSyntaxTheme'],
};

// Auto-resolve stub names for relative path stubs (key matching is by suffix)
const RELATIVE_STUB_EXPORTS = {
  'connectorText.js': ['isConnectorTextBlock', 'ConnectorTextBlock'],
  'TungstenTool.js': ['TungstenTool'],
  'WorkflowTool/constants.js': ['WORKFLOW_TOOL_NAME'],
  'types.js': ['DEFAULT_UPLOAD_CONCURRENCY', 'FILE_COUNT_LIMIT', 'OUTPUTS_SUBDIR'],
};

function getStubExportsForPath(p) {
  // Check direct match
  if (STUB_NAMED_EXPORTS[p]) return STUB_NAMED_EXPORTS[p];
  // Check suffix match for relative paths
  for (const [suffix, exports] of Object.entries(RELATIVE_STUB_EXPORTS)) {
    if (p.endsWith(suffix)) return exports;
  }
  return [];
}

// ── bun:bundle shim plugin ───────────────────────────────────────────
const bunBundlePlugin = {
  name: 'bun-bundle-shim',
  setup(build) {
    build.onResolve({ filter: /^bun:bundle$/ }, () => ({
      path: 'bun:bundle',
      namespace: 'bun-bundle-shim',
    }));
    build.onLoad({ filter: /.*/, namespace: 'bun-bundle-shim' }, () => ({
      contents: `
        const FLAGS = ${JSON.stringify(FEATURE_FLAGS)};
        export function feature(name) {
          return FLAGS[name] ?? false;
        }
      `,
      loader: 'js',
    }));
  },
};

// ── Missing module stub plugin ───────────────────────────────────────
// Returns empty stubs for modules that don't exist in the npm package
const missingModulePlugin = {
  name: 'missing-module-stub',
  setup(build) {
    // Stub private/internal packages
    for (const prefix of PRIVATE_PACKAGES) {
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
      build.onResolve({ filter: new RegExp(`^${escaped}`) }, (args) => ({
        path: args.path,
        namespace: 'stub-module',
      }));
    }

    // Stub .d.ts imports (type-only, no runtime content)
    build.onResolve({ filter: /\.d\.ts$/ }, () => ({
      path: 'types-stub',
      namespace: 'stub-module',
    }));

    // Stub .txt and .md file imports (classifier prompts, skill content, etc.)
    build.onResolve({ filter: /\.(txt|md)$/ }, (args) => {
      const dir = args.resolveDir;
      const fullPath = path.resolve(dir, args.path);
      if (!existsSync(fullPath)) {
        return { path: args.path, namespace: 'text-stub' };
      }
    });
    build.onLoad({ filter: /.*/, namespace: 'text-stub' }, () => ({
      contents: `export default "";`,
      loader: 'js',
    }));

    // Stub missing source modules (check if file actually exists)
    build.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.path.startsWith('.')) return;

      const dir = args.resolveDir;
      const basePath = path.resolve(dir, args.path);

      // Check if any variant exists
      const variants = [
        basePath,
        basePath.replace(/\.js$/, '.ts'),
        basePath.replace(/\.js$/, '.tsx'),
      ];

      if (variants.some(v => existsSync(v))) return; // file exists, let other plugins handle

      // Check if it matches a known missing module pattern
      for (const missing of MISSING_MODULES) {
        if (args.path.includes(missing) || args.path.startsWith(missing)) {
          return {
            path: args.path,
            namespace: 'stub-module',
          };
        }
      }

      // If no variant exists at all, stub it
      if (!variants.some(v => existsSync(v))) {
        console.warn(`  [stub] Missing module: ${args.path} (from ${args.importer})`);
        return {
          path: args.path,
          namespace: 'stub-module',
        };
      }
    });

    build.onLoad({ filter: /.*/, namespace: 'stub-module' }, (args) => {
      // Special stubs that need functional objects (not just undefined)
      if (args.path.includes('claude-for-chrome-mcp')) {
        return {
          contents: `
            export const BROWSER_TOOLS = [];
            export const CHROME_TOOL_NAMES = [];
            export const createClaudeForChromeMcpServer = () => {};
            export default {};
          `,
          loader: 'js',
        };
      }
      if (args.path.includes('computer-use-mcp')) {
        return {
          contents: `
            export const buildComputerUseTools = () => [];
            export const createComputerUseMcpServer = () => {};
            export const bindSessionContext = () => {};
            export const DEFAULT_GRANT_FLAGS = {};
            export const API_RESIZE_PARAMS = {};
            export const targetImageSize = () => ({});
            export const getSentinelCategory = () => null;
            export default {};
          `,
          loader: 'js',
        };
      }
      if (args.path.includes('sandbox-runtime')) {
        return {
          contents: `
            // Stub for @anthropic-ai/sandbox-runtime
            const noop = () => {};
            const noopAsync = () => Promise.resolve();
            const noopObj = () => ({});
            const handler = { get: (_, prop) => (typeof prop === 'string' ? noop : undefined) };
            export const SandboxManager = new Proxy({
              getFsReadConfig: noopObj,
              getFsWriteConfig: noopObj,
              getNetworkRestrictionConfig: noopObj,
              checkDependencies: noopAsync,
              isSupportedPlatform: () => false,
              wrapWithSandbox: (fn) => fn,
              initialize: noopAsync,
              updateConfig: noop,
              reset: noop,
            }, handler);
            export const SandboxRuntimeConfigSchema = { parse: (x) => x };
            export const SandboxViolationStore = { getViolations: () => [], subscribe: noop };
            export default {};
          `,
          loader: 'js',
        };
      }

      // Look up any known named exports that importing files expect
      const exports = getStubExportsForPath(args.path);
      const exportLines = exports.map(
        (name) => `export const ${name} = undefined;`
      ).join('\n');

      return {
        contents: `
          // Stub for missing module: ${args.path}
          export default {};
          export const __stub__ = true;
          ${exportLines}
        `,
        loader: 'js',
      };
    });
  },
};

// ── Source path alias plugin ─────────────────────────────────────────
// Handles bare `src/` path imports (e.g., `from 'src/utils/cwd.js'`)
const srcAliasPlugin = {
  name: 'src-alias',
  setup(build) {
    build.onResolve({ filter: /^src\// }, (args) => {
      const resolved = path.join(srcDir, args.path.slice(4)); // remove 'src/'

      // Try .ts, .tsx, then .js
      for (const ext of ['.ts', '.tsx', '.js']) {
        const withExt = resolved.replace(/\.js$/, ext);
        if (existsSync(withExt)) {
          return { path: withExt };
        }
      }
      // Try as directory with index
      for (const ext of ['.ts', '.tsx', '.js']) {
        const indexPath = path.join(resolved.replace(/\.js$/, ''), `index${ext}`);
        if (existsSync(indexPath)) {
          return { path: indexPath };
        }
      }
      // If nothing exists, stub it
      console.warn(`  [stub] Missing src alias: ${args.path} (from ${args.importer})`);
      return { path: args.path, namespace: 'stub-module' };
    });
  },
};

// ── .js → .ts/.tsx resolver plugin ───────────────────────────────────
// Source files import with .js extension but actual files are .ts/.tsx
const tsResolverPlugin = {
  name: 'ts-resolver',
  setup(build) {
    build.onResolve({ filter: /\.js$/ }, (args) => {
      if (args.kind === 'entry-point') return;
      if (!args.path.startsWith('.')) return; // skip node_modules
      if (args.namespace === 'stub-module') return; // skip stubs

      const dir = args.resolveDir;
      const jsPath = path.resolve(dir, args.path);

      // Try .ts, .tsx replacements
      for (const ext of ['.ts', '.tsx']) {
        const tsPath = jsPath.replace(/\.js$/, ext);
        if (existsSync(tsPath)) {
          return { path: tsPath };
        }
      }
      // If the .js file itself exists, use it
      if (existsSync(jsPath)) {
        return { path: jsPath };
      }
      // Try as directory with index
      const dirPath = jsPath.replace(/\.js$/, '');
      for (const ext of ['.ts', '.tsx', '.js']) {
        const indexPath = path.join(dirPath, `index${ext}`);
        if (existsSync(indexPath)) {
          return { path: indexPath };
        }
      }
    });
  },
};

// ── Build ────────────────────────────────────────────────────────────
console.log(`Building Claude Code v${VERSION} from source...`);
console.log(`  Entry: src/entrypoints/cli.tsx`);
console.log(`  Output: ${outfile}`);
console.log(`  Minify: ${doMinify}`);
console.log(`  Sourcemap: ${doSourcemap}`);
console.log('');

try {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, 'src/entrypoints/cli.tsx')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: path.join(__dirname, outfile),
    minify: doMinify,
    sourcemap: doSourcemap,
    banner: {
      js: [
        '#!/usr/bin/env node',
        `// Claude Code v${VERSION} - Built from source on ${new Date().toISOString()}`,
        `// (c) Anthropic PBC. All rights reserved.`,
        '',
        `import { createRequire as __createRequire } from 'node:module';`,
        `import { fileURLToPath as __fileURLToPath } from 'node:url';`,
        `import { dirname as __dirname_fn } from 'node:path';`,
        `const __filename = __fileURLToPath(import.meta.url);`,
        `const __dirname = __dirname_fn(__filename);`,
        `const require = __createRequire(import.meta.url);`,
        '',
      ].join('\n'),
    },
    define: {
      ...MACROS,
    },
    // Plugin order matters: stubs first, then aliases, then ts resolver
    plugins: [
      bunBundlePlugin,
      missingModulePlugin,
      srcAliasPlugin,
      tsResolverPlugin,
    ],
    external: [
      // Native .node addons must stay external
      '*.node',
      // Platform-specific sharp binaries
      '@img/sharp-*',
      // Sharp itself (uses native bindings, resolved at runtime)
      'sharp',
      // AWS/Azure/GCP SDK packages (dynamically imported at runtime)
      '@aws-sdk/client-bedrock',
      '@aws-sdk/client-sts',
      '@anthropic-ai/bedrock-sdk',
      '@anthropic-ai/foundry-sdk',
      '@anthropic-ai/vertex-sdk',
      '@azure/identity',
      // Optional compression
      'fflate',
      // Telemetry exporters (dynamically imported, optional)
      '@opentelemetry/exporter-metrics-otlp-grpc',
      '@opentelemetry/exporter-metrics-otlp-http',
      '@opentelemetry/exporter-metrics-otlp-proto',
      '@opentelemetry/exporter-prometheus',
      '@opentelemetry/exporter-logs-otlp-grpc',
      '@opentelemetry/exporter-logs-otlp-http',
      '@opentelemetry/exporter-logs-otlp-proto',
      '@opentelemetry/exporter-trace-otlp-grpc',
      '@opentelemetry/exporter-trace-otlp-http',
      '@opentelemetry/exporter-trace-otlp-proto',
      // Optional runtime dependencies (native addons)
      'turndown',
      'modifiers-napi',
      'audio-capture-napi',
    ],
    jsx: 'automatic',
    jsxImportSource: 'react',
    logLevel: 'warning',
    treeShaking: true,
    splitting: false,
    metafile: false,
    // Resolve from node_modules
    nodePaths: [path.join(__dirname, 'node_modules')],
  });

  console.log('Build complete!\n');

  const stat = statSync(path.join(__dirname, outfile));
  console.log(`Output: ${outfile} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`\nTo run: node ${outfile}`);
  console.log(`To install globally: chmod +x ${outfile} && npm link`);
} catch (err) {
  console.error('Build failed:', err.message);
  if (err.errors) {
    for (const e of err.errors) {
      console.error(`  ${e.location?.file}:${e.location?.line}: ${e.text}`);
    }
  }
  process.exit(1);
}
