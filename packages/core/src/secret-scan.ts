/**
 * High-precision secret scanning + redaction for the cloud (learned-provider)
 * embed path. Pure, deterministic, no network. Used to gate any text that would
 * leave the machine: callers run {@link prepareForCloud} before a cloud send.
 *
 * The local/default embedding path must never call any of these helpers — they
 * exist solely to protect cloud egress.
 */

export type SecretKind =
  | 'aws-access-key-id'
  | 'github-token'
  | 'slack-token'
  | 'stripe-secret-key'
  | 'google-api-key'
  | 'private-key'
  | 'generic-credential-assignment'
  | 'high-entropy-assignment'
  | 'bearer-jwt'

export interface SecretFinding {
  /** Stable category of the detected secret. */
  kind: SecretKind
  /** Human-readable label for error messages. */
  label: string
  /** Index of the text within the scanned batch (0 for single-string scans). */
  textIndex: number
  /** 1-based line number within the scanned text. */
  line: number
  /** The raw matched substring (never logged or sent anywhere). */
  match: string
}

interface PatternSpec {
  kind: SecretKind
  label: string
  pattern: RegExp
  /**
   * Index of the capture group holding the sensitive value to mask. When
   * omitted the whole match is masked.
   */
  valueGroup?: number
  /**
   * Optional gate on the captured value: a match is only treated as a finding
   * (and only redacted) when this returns true. Lets a broad regex stay precise
   * by deferring to a value test (e.g. Shannon entropy) the regex can't express.
   */
  valuePredicate?: (value: string) => boolean
}

const REDACTION = '[REDACTED]'

// Each pattern is intentionally scoped to keep false positives low. Patterns are
// applied with the global flag against each individual line. The credential
// patterns are case-insensitive and match bare keyword keys (`API_KEY=`) as well
// as prefixed/camelCase ones (`FOO_API_KEY=`, `apiKey=`); the high-entropy
// detector catches structureless secrets bound to any identifier.
const PATTERNS: PatternSpec[] = [
  {
    kind: 'aws-access-key-id',
    label: 'AWS access key id',
    pattern: /\b((?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16})\b/g,
    valueGroup: 1
  },
  {
    kind: 'github-token',
    label: 'GitHub token',
    pattern: /\b(gh[poasur]_[A-Za-z0-9]{20,255})\b/g,
    valueGroup: 1
  },
  {
    kind: 'slack-token',
    label: 'Slack token',
    pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    valueGroup: 1
  },
  {
    kind: 'stripe-secret-key',
    label: 'Stripe secret key',
    pattern: /\b(sk_(?:live|test)_[A-Za-z0-9]{16,})\b/g,
    valueGroup: 1
  },
  {
    kind: 'google-api-key',
    label: 'Google API key',
    pattern: /\b(AIza[A-Za-z0-9_-]{16,})\b/g,
    valueGroup: 1
  },
  {
    kind: 'generic-credential-assignment',
    label: 'credential assignment',
    // Key whose name ends in a credential keyword, case-insensitive, bare or
    // prefixed/camelCase: API_KEY=, FOO_API_KEY=, apiKey=, accessToken:, db_password=,
    // clientSecret = '...'. The `[A-Za-z0-9_]*` allows zero prefix so a bare keyword matches.
    pattern:
      /(?<![A-Za-z0-9_])([A-Za-z0-9_]*(?:API[_-]?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD))\s*[=:]\s*["'`]?([^\s"'`]{6,})["'`]?/gi,
    valueGroup: 2
  },
  {
    kind: 'high-entropy-assignment',
    label: 'high-entropy secret',
    // Any identifier assigned a quoted, long, high-entropy literal — catches
    // structureless secrets (Stripe/Google/random tokens) bound to lowercase or
    // innocuous-looking names. The entropy gate keeps long prose/URLs out.
    pattern: /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*["'`]([A-Za-z0-9+/_=-]{20,})["'`]/g,
    valueGroup: 2,
    valuePredicate: (value) => shannonEntropy(value) >= 3.6
  },
  {
    kind: 'bearer-jwt',
    label: 'Bearer JWT',
    pattern: /\b(Bearer\s+)(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})/g,
    valueGroup: 2
  }
]

/** Shannon entropy in bits per character; ~3.6+ marks a likely random secret. */
function shannonEntropy(value: string): number {
  if (!value) {
    return 0
  }

  const counts = new Map<string, number>()
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1)
  }

  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / value.length
    entropy -= probability * Math.log2(probability)
  }

  return entropy
}

// PEM private-key blocks span multiple lines, so they are matched against the
// whole text rather than per-line.
const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g

/**
 * Scan a single text for secrets. Returns one finding per match, with the
 * detected kind, a label, the 1-based line, and the raw match. Deterministic
 * and side-effect free.
 */
export function scanSecrets(text: string, textIndex = 0): SecretFinding[] {
  if (!text) {
    return []
  }

  const findings: SecretFinding[] = []

  for (const match of text.matchAll(PRIVATE_KEY_PATTERN)) {
    findings.push({
      kind: 'private-key',
      label: 'private key (PEM block)',
      textIndex,
      line: lineNumberAt(text, match.index ?? 0),
      match: match[0]
    })
  }

  const lines = text.split('\n')
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineText = lines[lineIndex] ?? ''

    for (const spec of PATTERNS) {
      spec.pattern.lastIndex = 0
      for (const match of lineText.matchAll(spec.pattern)) {
        findings.push({
          kind: spec.kind,
          label: spec.label,
          textIndex,
          line: lineIndex + 1,
          match: match[0]
        })
      }
    }
  }

  return findings
}

/**
 * Return a copy of `text` with every detected secret value masked. The
 * surrounding structure (assignment keys, `Bearer ` prefix, PEM markers) is
 * preserved so the redacted text stays recognizable.
 */
export function redactSecrets(text: string): string {
  if (!text) {
    return text
  }

  let redacted = text.replace(PRIVATE_KEY_PATTERN, REDACTION)

  for (const spec of PATTERNS) {
    spec.pattern.lastIndex = 0
    redacted = redacted.replace(spec.pattern, (whole, ...groups) => {
      if (spec.valueGroup === undefined) {
        return REDACTION
      }

      const value = groups[spec.valueGroup - 1] as string | undefined
      if (value === undefined) {
        return REDACTION
      }

      // Replace only the captured value within the whole match, leaving the
      // key / prefix intact for context.
      const lastIndex = (whole as string).lastIndexOf(value)
      if (lastIndex < 0) {
        return REDACTION
      }

      return (whole as string).slice(0, lastIndex) + REDACTION + (whole as string).slice(lastIndex + value.length)
    })
  }

  return redacted
}

export interface PrepareForCloudOptions {
  allowSecrets?: boolean
}

/**
 * Gate a batch of texts before a cloud send.
 *
 * - No findings → returns the input array unchanged.
 * - Findings and `!allowSecrets` → throws an Error naming the secret kinds and
 *   instructing the user to re-run with `--allow-secrets`.
 * - Findings and `allowSecrets` → returns a redacted copy of every text.
 *
 * Pure and deterministic; performs no I/O.
 */
export function prepareForCloud(texts: string[], opts: PrepareForCloudOptions = {}): string[] {
  const findings: SecretFinding[] = []
  for (let index = 0; index < texts.length; index += 1) {
    findings.push(...scanSecrets(texts[index] ?? '', index))
  }

  if (findings.length === 0) {
    return texts
  }

  if (!opts.allowSecrets) {
    throw new Error(buildSecretRefusalMessage(findings))
  }

  return texts.map((text) => redactSecrets(text))
}

function buildSecretRefusalMessage(findings: SecretFinding[]): string {
  const kinds = [...new Set(findings.map((finding) => finding.label))].sort()
  const summary = kinds.join(', ')
  return (
    `Refusing to send content to the cloud embedding provider: detected ${findings.length} potential secret${
      findings.length === 1 ? '' : 's'
    } (${summary}). ` +
    'Remove the secret(s) from the indexed content, or re-run with --allow-secrets to send a redacted copy.'
  )
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1
    }
  }
  return line
}
