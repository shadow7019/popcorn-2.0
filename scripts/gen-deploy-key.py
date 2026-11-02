#!/usr/bin/env python3
"""Generate a fresh SSH deploy keypair in .ssh-deploy/ using paramiko
(there is no ssh-keygen binary in this sandbox). Idempotent: refuses to
overwrite an existing key so a registered public key is never rotated
silently."""
import os
import sys

DIR = "/home/z/my-project/.ssh-deploy"
PRIV = os.path.join(DIR, "id_ed25519")
PUB = PRIV + ".pub"

os.makedirs(DIR, mode=0o700, exist_ok=True)
if os.path.exists(PRIV):
    print(f"key already exists: {PRIV} — keeping it")
    sys.exit(0)

import paramiko

try:
    key = paramiko.Ed25519Key.generate()
    ktype = "ed25519"
except Exception as e:  # very old paramiko: fall back to RSA
    print(f"Ed25519Key.generate unavailable ({e}); generating RSA-3072")
    key = paramiko.RSAKey.generate(3072)
    ktype = "rsa"

key.write_private_key_file(PRIV)
with open(PUB, "w") as f:
    f.write(f"{key.get_name()} {key.get_base64()} popcorn-2.0-deploy\n")
os.chmod(PRIV, 0o600)
os.chmod(PUB, 0o644)
print(f"generated {ktype} keypair: {PRIV}")
