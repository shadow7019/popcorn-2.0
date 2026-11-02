#!/usr/bin/env python3
"""Generate a fresh SSH deploy keypair in .ssh-deploy/ using paramiko
(there is no ssh-keygen binary in this sandbox). Idempotent: refuses to
overwrite an existing key so a registered public key is never rotated
silently."""
import os
import sys

DIR = "/home/z/my-project/.ssh-deploy"
# optional argv[1] = key filename, e.g. `gen-deploy-key.py id_otama` to mint a
# second key for a different repo (GitHub allows a deploy key on one repo only)
KEYNAME = sys.argv[1] if len(sys.argv) > 1 else "id_ed25519"
PRIV = os.path.join(DIR, KEYNAME)
PUB = PRIV + ".pub"

os.makedirs(DIR, mode=0o700, exist_ok=True)
if os.path.exists(PRIV):
    print(f"key already exists: {PRIV} — keeping it")
    sys.exit(0)

import paramiko

try:
    # Prefer Ed25519: short public key (~100 chars) survives copy-paste into
    # GitHub's key textarea far better than a multi-hundred-char RSA line.
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey,
    )

    key = Ed25519PrivateKey.generate()
    priv = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.OpenSSH,
        serialization.NoEncryption(),
    )
    pub = (
        key.public_key()
        .public_bytes(
            serialization.Encoding.OpenSSH,
            serialization.PublicFormat.OpenSSH,
        )
        .decode()
        .rstrip()
    )
    with open(PRIV, "wb") as f:
        f.write(priv)
    with open(PUB, "w") as f:
        f.write(f"{pub} popcorn-2.0-deploy\n")
    os.chmod(PRIV, 0o600)
    os.chmod(PUB, 0o644)
    print(f"generated ed25519 keypair: {PRIV}")
    sys.exit(0)
except ImportError:
    pass  # fall back to paramiko RSA below

try:
    key = paramiko.Ed25519Key.generate()
    ktype = "ed25519"
except Exception as e:  # older paramiko: fall back to RSA
    print(f"ed25519 unavailable ({e}); generating RSA-3072")
    key = paramiko.RSAKey.generate(3072)
    ktype = "rsa"

key.write_private_key_file(PRIV)
with open(PUB, "w") as f:
    f.write(f"{key.get_name()} {key.get_base64()} popcorn-2.0-deploy\n")
os.chmod(PRIV, 0o600)
os.chmod(PUB, 0o644)
print(f"generated {ktype} keypair: {PRIV}")
