import Database from 'better-sqlite3'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openRepo } from '../src/index.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true })
    })
  )
})

async function createRepo(prefix: string): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(repoRoot)
  return repoRoot
}

describe('M3 language and chunker hardening', () => {
  it('extracts structural symbols for Go, Java, Ruby, and Rust plus heading/key-aware docs/config', async () => {
    const repoRoot = await createRepo('codesift-m3-languages-')
    await mkdir(join(repoRoot, 'go'), { recursive: true })
    await mkdir(join(repoRoot, 'java'), { recursive: true })
    await mkdir(join(repoRoot, 'ruby'), { recursive: true })
    await mkdir(join(repoRoot, 'rust'), { recursive: true })
    await mkdir(join(repoRoot, 'docs'), { recursive: true })
    await mkdir(join(repoRoot, 'config'), { recursive: true })

    await writeFile(
      join(repoRoot, 'go', 'auth.go'),
      `package auth

type TokenVerifier struct{}

type TokenPolicy interface {
  Allows(token string) bool
}

func NewTokenVerifier() *TokenVerifier {
  return &TokenVerifier{}
}

func (v *TokenVerifier) VerifyToken(token string) bool {
  return token != ""
}
`,
      'utf8'
    )

    await writeFile(
      join(repoRoot, 'java', 'TokenVerifier.java'),
      `package auth;

public class TokenVerifier {
  public boolean verifyToken(String token) {
    return token != null;
  }
}

interface TokenPolicy {
  boolean allows(String token);
}
`,
      'utf8'
    )

    await writeFile(
      join(repoRoot, 'ruby', 'token_verifier.rb'),
      `module Auth
  class TokenVerifier
    def verify_token(token)
      !token.empty?
    end
  end
end
`,
      'utf8'
    )

    await writeFile(
      join(repoRoot, 'rust', 'token_verifier.rs'),
      `pub struct TokenVerifier;

pub trait TokenPolicy {
    fn allows(&self, token: &str) -> bool;
}

impl TokenVerifier {
    pub fn verify_token(&self, token: &str) -> bool {
        !token.is_empty()
    }
}
`,
      'utf8'
    )

    await writeFile(
      join(repoRoot, 'docs', 'search.md'),
      `# Search guide

General notes.

## Retry timeout

Configure retry timeout budgets here for agents.
`,
      'utf8'
    )

    await writeFile(
      join(repoRoot, 'config', 'app.yaml'),
      `retry_timeout_ms: 5000
auth:
  token_header: Authorization
`,
      'utf8'
    )

    await writeFile(
      join(repoRoot, 'config', 'package.json'),
      `{
  "retryTimeoutMs": 5000,
  "auth": {
    "tokenHeader": "Authorization"
  }
}
`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    expect(await repo.findSymbol('VerifyToken', { pathGlob: 'go/**' })).toMatchObject([
      { file: 'go/auth.go', kind: 'method', parent: 'TokenVerifier', language: 'go' }
    ])
    expect(await repo.findSymbol('verifyToken', { pathGlob: 'java/**' })).toMatchObject([
      { file: 'java/TokenVerifier.java', kind: 'method', parent: 'TokenVerifier', language: 'java' }
    ])
    expect(await repo.findSymbol('verify_token', { pathGlob: 'ruby/**' })).toMatchObject([
      { file: 'ruby/token_verifier.rb', kind: 'method', parent: 'TokenVerifier', language: 'ruby' }
    ])
    expect(await repo.findSymbol('verify_token', { pathGlob: 'rust/**' })).toMatchObject([
      { file: 'rust/token_verifier.rs', kind: 'method', parent: 'TokenVerifier', language: 'rust' }
    ])
    expect(await repo.findSymbol('TokenPolicy')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: 'go/auth.go', kind: 'interface' }),
        expect.objectContaining({ file: 'java/TokenVerifier.java', kind: 'interface' }),
        expect.objectContaining({ file: 'rust/token_verifier.rs', kind: 'interface' })
      ])
    )

    const markdownHits = await repo.search('retry timeout budgets', { lang: ['markdown'], k: 1 })
    expect(markdownHits[0]).toMatchObject({ file: 'docs/search.md', symbol: 'Retry timeout', kind: 'module' })

    expect(await repo.findSymbol('retry_timeout_ms')).toMatchObject([
      { file: 'config/app.yaml', kind: 'variable', language: 'yaml' }
    ])
    expect(await repo.findSymbol('retryTimeoutMs')).toMatchObject([
      { file: 'config/package.json', kind: 'variable', language: 'json' }
    ])
  })

  it('handles real-world declaration shapes without tree-sitter native dependencies', async () => {
    const repoRoot = await createRepo('codesift-m3-parser-quality-')
    await mkdir(join(repoRoot, 'go'), { recursive: true })
    await mkdir(join(repoRoot, 'java'), { recursive: true })
    await mkdir(join(repoRoot, 'ruby'), { recursive: true })
    await mkdir(join(repoRoot, 'rust', 'src'), { recursive: true })

    await writeFile(
      join(repoRoot, 'go', 'token.go'),
      `package auth

const (
  DefaultAudience = "agents"
  TokenIssuer string = "codesift"
)

var (
  RetryBudgetMS = 250
)

type (
  TokenPolicy interface {
    Allows(token string) bool
  }
  TokenVerifier[T any] struct {
    audience string
  }
  TokenAlias = string
)

func NewTokenVerifier() *TokenVerifier[string] {
  return &TokenVerifier[string]{}
}

func (v *TokenVerifier[T]) VerifyToken(
  token string,
) bool {
  if token == "" {
    panic("missing bearer token {not a block}")
  }
  return token != ""
}
`,
      'utf8'
    )

    await writeFile(
      join(repoRoot, 'java', 'TokenVerifier.java'),
      `package auth;

public class TokenVerifier {
  public static final String DEFAULT_AUDIENCE = "agents";
  private int retryBudgetMs = 250, burstBudget = 5;

  public TokenVerifier() {}

  public boolean verifyToken(String token) {
    if (token == null) {
      throw new IllegalArgumentException("missing bearer token {not a block}");
    }
    return !token.isEmpty();
  }

  public enum AuthMode {
    STRICT,
    LENIENT;
  }
}

interface TokenPolicy {
  boolean allows(String token);
}
`,
      'utf8'
    )

    await writeFile(
      join(repoRoot, 'ruby', 'token_verifier.rb'),
      `module Auth
  class TokenVerifier
    DEFAULT_AUDIENCE = "agents"
    @@retry_budget_ms = 250

    def verify_token(token)
      raise "missing bearer token {not a block}" if token.nil?
      !token.empty?
    end
  end
end
`,
      'utf8'
    )

    await writeFile(
      join(repoRoot, 'rust', 'src', 'lib.rs'),
      `pub mod auth {
    pub const DEFAULT_AUDIENCE: &str = "agents";
    pub static mut RETRY_BUDGET_MS: u64 = 250;

    pub struct TokenVerifier;

    pub trait TokenPolicy {
        fn allows(&self, token: &str) -> bool;
    }

    impl TokenVerifier {
        pub fn verify_token(&self, token: &str) -> bool {
            if token.is_empty() {
                panic!("missing bearer token {not a block}");
            }
            true
        }
    }
}
`,
      'utf8'
    )

    const repo = await openRepo(repoRoot)
    await repo.sync()

    expect(await repo.findSymbol('DefaultAudience', { pathGlob: 'go/**' })).toMatchObject([
      { kind: 'constant', file: 'go/token.go' }
    ])
    expect(await repo.findSymbol('RetryBudgetMS', { pathGlob: 'go/**' })).toMatchObject([
      { kind: 'variable', file: 'go/token.go' }
    ])
    expect(await repo.findSymbol('TokenAlias', { pathGlob: 'go/**' })).toMatchObject([
      { kind: 'type', file: 'go/token.go' }
    ])
    expect(await repo.findSymbol('VerifyToken', { pathGlob: 'go/**' })).toMatchObject([
      { kind: 'method', parent: 'TokenVerifier', file: 'go/token.go' }
    ])

    expect(await repo.findSymbol('DEFAULT_AUDIENCE', { pathGlob: 'java/**' })).toMatchObject([
      { kind: 'constant', parent: 'TokenVerifier', file: 'java/TokenVerifier.java' }
    ])
    expect(await repo.findSymbol('retryBudgetMs', { pathGlob: 'java/**' })).toMatchObject([
      { kind: 'variable', parent: 'TokenVerifier', file: 'java/TokenVerifier.java' }
    ])
    expect(await repo.findSymbol('STRICT', { pathGlob: 'java/**' })).toMatchObject([
      { kind: 'constant', parent: 'AuthMode', file: 'java/TokenVerifier.java' }
    ])

    expect(await repo.findSymbol('DEFAULT_AUDIENCE', { pathGlob: 'ruby/**' })).toMatchObject([
      { kind: 'constant', parent: 'TokenVerifier', file: 'ruby/token_verifier.rb' }
    ])
    expect(await repo.findSymbol('@@retry_budget_ms', { pathGlob: 'ruby/**' })).toMatchObject([
      { kind: 'variable', parent: 'TokenVerifier', file: 'ruby/token_verifier.rb' }
    ])

    expect(await repo.findSymbol('DEFAULT_AUDIENCE', { pathGlob: 'rust/**' })).toMatchObject([
      { kind: 'constant', parent: 'auth', file: 'rust/src/lib.rs' }
    ])
    expect(await repo.findSymbol('RETRY_BUDGET_MS', { pathGlob: 'rust/**' })).toMatchObject([
      { kind: 'variable', parent: 'auth', file: 'rust/src/lib.rs' }
    ])
    expect(await repo.findSymbol('verify_token', { pathGlob: 'rust/**' })).toMatchObject([
      { kind: 'method', parent: 'TokenVerifier', file: 'rust/src/lib.rs' }
    ])

    const javaSearchHits = await repo.search('missing bearer token', { k: 1, pathGlob: 'java/**' })
    expect(javaSearchHits[0]).toMatchObject({ file: 'java/TokenVerifier.java', symbol: 'verifyToken', parent: 'TokenVerifier' })
    expect(await repo.grep('missing bearer token {not a block}', { maxMatches: 4 })).toHaveLength(4)
  })

  it('splits oversized chunks, down-ranks generated files, annotates generated hits, and honors nested ignore files', async () => {
    const repoRoot = await createRepo('codesift-m3-hardening-')
    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await mkdir(join(repoRoot, 'pkg', 'ignored'), { recursive: true })
    await mkdir(join(repoRoot, 'vendor'), { recursive: true })

    const hugeMethods = Array.from({ length: 180 }, (_, index) => `  method${index}(): number { return ${index} }`).join('\n')
    await writeFile(
      join(repoRoot, 'src', 'huge.ts'),
      `export class HugeService {
${hugeMethods}
}
`,
      'utf8'
    )

    await writeFile(
      join(repoRoot, 'src', 'manual.ts'),
      `// handwritten shared ranking token
export function handwrittenRanking(): string {
  return 'shared ranking token'
}
`,
      'utf8'
    )
    await writeFile(
      join(repoRoot, 'src', 'api.generated.ts'),
      `// Code generated by test fixture. DO NOT EDIT.
export function generatedRanking(): string {
  return 'shared ranking token'
}
`,
      'utf8'
    )
    await writeFile(join(repoRoot, 'pkg', '.gitignore'), 'ignored/\n', 'utf8')
    await writeFile(join(repoRoot, 'pkg', 'ignored', 'hidden.ts'), `export const HIDDEN_TOKEN = 'hidden'\n`, 'utf8')
    await writeFile(join(repoRoot, 'pkg', 'visible.ts'), `export const VISIBLE_TOKEN = 'visible'\n`, 'utf8')
    await writeFile(join(repoRoot, 'vendor', 'vendored.ts'), `export const VENDORED_TOKEN = 'vendored'\n`, 'utf8')

    const repo = await openRepo(repoRoot)
    await repo.sync()

    const db = new Database(join(repoRoot, '.codesift', 'index.db'))
    const maxHugeChunk = db
      .prepare<[], { max_lines: number }>(
        "select max(end_line - start_line + 1) as max_lines from chunks where file_path = 'src/huge.ts'"
      )
      .get()
    const generatedFlag = db
      .prepare<[string], { generated: number }>('select generated from files where path = ?')
      .get('src/api.generated.ts')
    db.close()

    expect(maxHugeChunk?.max_lines).toBeLessThanOrEqual(90)
    expect(generatedFlag?.generated).toBe(1)

    const status = await repo.status()
    const rankingHits = await repo.search('shared ranking token', { k: 2, pathGlob: 'src/**' })
    const generatedHit = rankingHits.find((hit) => hit.file === 'src/api.generated.ts')
    expect(status.generatedFileCount).toBe(1)
    expect(status.generatedChunkCount).toBeGreaterThanOrEqual(1)
    expect(rankingHits[0]?.file).toBe('src/manual.ts')
    expect(generatedHit).toMatchObject({ generated: true })

    expect(await repo.grep('HIDDEN_TOKEN')).toHaveLength(0)
    expect(await repo.grep('VISIBLE_TOKEN')).toMatchObject([{ file: 'pkg/visible.ts' }])
    expect(await repo.grep('VENDORED_TOKEN')).toHaveLength(0)
  })
})
