#!/usr/bin/env python3
"""
Pre-publish safety check for Intrinsic.

Run this before pushing to GitHub or deploying:

    python check_secrets.py

It scans the project for credential-like strings, sensitive filenames, and
placeholders that would leak personal or environment detail. Exit code 0 means
clean; 1 means something needs attention.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

SCAN_EXTENSIONS = {
    ".py", ".js", ".mjs", ".html", ".css", ".json",
    ".md", ".txt", ".bat", ".ps1", ".sh", ".yml", ".yaml",
    ".toml", ".cfg", ".ini",
}

SKIP_DIRS = {
    "cache", "__pycache__", "screens", ".git", "node_modules",
    ".venv", "venv", ".chrome-cdp", ".chrome-sec",
}

# Patterns that indicate a real credential rather than documentation prose.
SECRET_PATTERNS = [
    (re.compile(r"(?i)\bapi[_-]?key\s*[:=]\s*['\"][A-Za-z0-9_\-]{8,}"), "API key assignment"),
    (re.compile(r"(?i)\bsecret\s*[:=]\s*['\"][A-Za-z0-9_\-]{8,}"), "secret assignment"),
    (re.compile(r"(?i)\btoken\s*[:=]\s*['\"][A-Za-z0-9_\-]{12,}"), "token assignment"),
    (re.compile(r"(?i)\bpassword\s*[:=]\s*['\"][^'\"\s]{6,}"), "password assignment"),
    (re.compile(r"\bsk-[A-Za-z0-9]{16,}"), "OpenAI-style key"),
    (re.compile(r"\bghp_[A-Za-z0-9]{20,}"), "GitHub personal access token"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"), "GitHub fine-grained token"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "AWS access key id"),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}"), "Slack token"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "private key block"),
    (re.compile(r"(?i)Authorization:\s*Bearer\s+[A-Za-z0-9._\-]{10,}"), "bearer header"),
]

# Personal or environment detail worth removing before a public push.
LEAK_PATTERNS = [
    (re.compile(r"C:\\Users\\[A-Za-z0-9._-]+", re.I), "absolute Windows user path"),
    (re.compile(r"/Users/[A-Za-z0-9._-]+/"), "absolute macOS user path"),
    (re.compile(r"/home/[A-Za-z0-9._-]+/"), "absolute Linux user path"),
    (re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"), "email address"),
]

SENSITIVE_FILES = {
    ".env", ".env.local", ".env.production", "secrets.json",
    "credentials.json", "id_rsa", "id_ed25519", ".npmrc", ".pypirc",
}


def iter_files():
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        yield path


def main() -> int:
    findings = []
    scanned = 0

    for path in iter_files():
        rel = path.relative_to(ROOT)

        if path.name in SENSITIVE_FILES or path.suffix in {".pem", ".key", ".p12"}:
            findings.append((rel, 0, "sensitive file present", path.name))
            continue

        if path.suffix.lower() not in SCAN_EXTENSIONS:
            continue

        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue

        scanned += 1
        for number, line in enumerate(text.splitlines(), 1):
            for pattern, label in SECRET_PATTERNS:
                if pattern.search(line):
                    findings.append((rel, number, f"possible secret: {label}", line.strip()[:100]))
            for pattern, label in LEAK_PATTERNS:
                if pattern.search(line):
                    findings.append((rel, number, f"personal detail: {label}", line.strip()[:100]))

    print()
    print("  Intrinsic - pre-publish safety check")
    print("  " + "-" * 36)
    print(f"  files scanned: {scanned}")

    # Known-safe documentation references, reported but not treated as failures.
    benign = []
    real = []
    for item in findings:
        rel, number, kind, snippet = item
        low = snippet.lower()
        safe_phrases = (
            "no api key", "no api-key", "no credential", "there are no",
            "never commit", "don't add secrets", "not in the repository",
            "placeholder", "example", "your-", "choose-something",
            "contact@example.com", "you@example.com",
        )
        if any(phrase in low for phrase in safe_phrases):
            benign.append(item)
        else:
            real.append(item)

    if benign:
        print(f"  documentation references (ignored): {len(benign)}")

    if not real:
        print()
        print("  PASS - no credentials or personal paths found.")
        print("  Safe to publish.")
        print()
        return 0

    print(f"  REVIEW - {len(real)} item(s) to look at:")
    print()
    for rel, number, kind, snippet in real:
        print(f"    {rel}:{number}")
        print(f"      {kind}")
        print(f"      {snippet}")
    print()
    print("  Fix these before publishing.")
    print()
    return 1


if __name__ == "__main__":
    sys.exit(main())
