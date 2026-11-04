"""Provision the PI L2 verifier OS-user boundary on a DISPOSABLE Linux runner. Run once, as root, BEFORE any
implementer or candidate code runs:

    sudo /usr/bin/python3 -I -S <pinned copy>/verifier_provision.py --broker-user "$USER"       --expect-code-sha256 <verifier-pin.json code_sha256> --lockdown

Run it from the copy CI materializes from the git objects named in verifier-pin.json, never from the PR working
tree: the code under review must not be able to replace its own verifier. It refuses (exit 2) before changing
anything if its own code files do not hash to the pinned value.

What it creates (fixed paths, see verifier_worker.py):
  users        pi-verifier (owns the signing key), pi-candidate (runs untrusted candidate code); no login shell
  /opt/pi-level2-verifier       root-owned copy of verifier_worker.py, handoff.py, harness.py, run-candidate
  /var/lib/pi-level2-verifier   keys/ (pi-verifier 0700, key 0600), out/ (pi-verifier 0755), inbox/ (broker 0755)
  /etc/pi-level2/trust.json     root-owned registry: the verifier public key bound to {"mode": "os-user"}
  /etc/sudoers.d/pi-level2      broker -> pi-verifier: only the installed worker; pi-verifier -> root: only run-candidate

--lockdown then removes the broker account's own escalation paths (passwordless sudo grants, docker socket), so the
broker/implementer account cannot read the key through root. This is intended for ephemeral CI VMs only: it
modifies sudoers and stops docker on the machine it runs on. It never touches credentials, network or providers.
"""
import argparse
import grp
import hashlib
import json
import os
import pwd
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import verifier_worker as vw  # noqa: E402

REGISTRY = Path("/etc/pi-level2/trust.json")
SUDOERS = Path("/etc/sudoers.d/pi-level2")
DISABLED = Path("/root/pi-level2-disabled-sudoers")
SYSTEM_PYTHON = "/usr/bin/python3"
HIDE = ("/var/lib/pi-level2-verifier", "/home", "/tmp", "/var/tmp", "/run", "/root")

RUN_CANDIDATE = """#!/bin/sh
# Root-owned. Runs the FIXED candidate harness as %(cand)s: no network, own pid/mount/ipc/uts namespaces, verifier
# state and home/tmp directories covered by empty tmpfs, hard resource limits, no new privileges. Takes no arguments;
# source and inputs arrive on stdin and outputs leave on stdout.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
[ "$#" -eq 0 ] || exit 64
cd /
exec /usr/bin/timeout -s KILL 15 /usr/bin/unshare --net --pid --mount --ipc --uts --fork --kill-child --mount-proc -- /bin/sh -c '
set -eu
for d in %(hide)s; do
 if [ -d "$d" ]; then /usr/bin/mount -t tmpfs -o size=64k,mode=755,nosuid,nodev,noexec tmpfs "$d"; fi
done
exec /usr/bin/prlimit --nofile=64 --nproc=32 --as=1073741824 --cpu=10 --fsize=1048576 -- \\
 /usr/bin/setpriv --reuid=%(cand)s --regid=%(cand)s --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all -- \\
 /usr/bin/env -i PATH=/usr/bin:/bin %(py)s -I -S %(harness)s'
"""


def run(*cmd, check=True, **kw):
 return subprocess.run(list(cmd), check=check, capture_output=True, text=True, **kw)


def ensure_user(name):
 try:
  return pwd.getpwnam(name)
 except KeyError:
  run("useradd", "--system", "--no-create-home", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin",
   "--user-group", name)
  return pwd.getpwnam(name)


def install_file(dst, data, mode, uid=0, gid=0):
 tmp = dst.with_name(dst.name + ".tmp")
 tmp.write_bytes(data)
 os.chown(tmp, uid, gid)
 os.chmod(tmp, mode)
 os.replace(tmp, dst)


def mkdir(path, uid, gid, mode):
 path.mkdir(parents=True, exist_ok=True)
 os.chown(path, uid, gid)
 os.chmod(path, mode)


def lockdown(broker):
 """Remove the broker's own root paths: passwordless sudo grants and the docker socket."""
 groups = {g.gr_name for g in grp.getgrall() if broker in g.gr_mem} | {grp.getgrgid(pwd.getpwnam(broker).pw_gid).gr_name}
 moved = []
 DISABLED.mkdir(mode=0o700, exist_ok=True)
 for f in sorted(Path("/etc/sudoers.d").iterdir()):
  if f == SUDOERS or f.name == "README":
   continue
  text = f.read_text(errors="replace")
  tokens = {broker} | {"%" + g for g in groups} | {"ALL"}
  if any(line.split()[:1] and line.split()[0] in tokens for line in text.splitlines() if not line.lstrip().startswith("#")):
   shutil.move(str(f), str(DISABLED / f.name))
   moved.append(f.name)
 for unit in ("docker.socket", "docker.service", "containerd.service"):
  run("systemctl", "stop", unit, check=False)
 for sock in ("/var/run/docker.sock", "/run/docker.sock", "/run/containerd/containerd.sock"):
  if os.path.exists(sock):
   os.chown(sock, 0, 0)
   os.chmod(sock, 0)
 if "docker" in groups:
  run("gpasswd", "-d", broker, "docker", check=False)
 probe = run("runuser", "-u", broker, "--", "sudo", "-n", "true", check=False)
 return {"moved_sudoers": moved, "broker_sudo_root_denied": probe.returncode != 0}


def main():
 ap = argparse.ArgumentParser()
 ap.add_argument("--broker-user", required=True)
 ap.add_argument("--lockdown", action="store_true")
 ap.add_argument("--expect-code-sha256", required=True,
  help="pinned verifier code hash (verifier-pin.json code_sha256); provisioning refuses any other code")
 ap.add_argument("--check-only", action="store_true", help="verify the code pin and exit without changing anything")
 a = ap.parse_args()
 # Pin check FIRST, before any change: the code about to be installed must be exactly the pinned code.
 actual = vw.code_sha256(HERE)
 if actual != a.expect_code_sha256:
  print(json.dumps({"error": "verifier_code_not_pinned", "expected": a.expect_code_sha256, "actual": actual}))
  sys.exit(2)
 if a.check_only:
  print(json.dumps({"pinned_code_ok": True, "code_sha256": actual}))
  return
 if os.geteuid() != 0:
  sys.exit("must run as root")
 broker = pwd.getpwnam(a.broker_user)
 if broker.pw_uid == 0 or a.broker_user in (vw.VERIFIER_USER, vw.CANDIDATE_USER):
  sys.exit("broker user must be an ordinary account")
 ver, cand = ensure_user(vw.VERIFIER_USER), ensure_user(vw.CANDIDATE_USER)

 mkdir(vw.INSTALL_DIR, 0, 0, 0o755)
 for name in vw.CODE_FILES:
  install_file(vw.INSTALL_DIR / name, (HERE / name).read_bytes(), 0o644)
 harness = vw.INSTALL_DIR / "harness.py"
 install_file(harness, vw.HARNESS_STDIN.encode("utf-8"), 0o644)
 script = RUN_CANDIDATE % {"cand": vw.CANDIDATE_USER, "hide": " ".join(HIDE), "py": SYSTEM_PYTHON, "harness": harness}
 install_file(vw.CANDIDATE_RUNNER, script.encode("ascii"), 0o755)

 installed_code = vw.code_sha256(vw.INSTALL_DIR)
 if installed_code != a.expect_code_sha256:
  sys.exit("installed verifier code does not match the pin")

 mkdir(vw.STATE_DIR, 0, 0, 0o755)
 mkdir(vw.OS_KEY.parent, ver.pw_uid, ver.pw_gid, 0o700)
 mkdir(vw.OS_OUT, ver.pw_uid, ver.pw_gid, 0o755)
 mkdir(vw.STATE_DIR / "inbox", broker.pw_uid, broker.pw_gid, 0o755)
 if not vw.OS_KEY.exists():
  # Generated BY the verifier account so the private key is never written by any other account.
  run("runuser", "-u", vw.VERIFIER_USER, "--", "sh", "-c",
   "umask 077 && /usr/bin/openssl genpkey -algorithm ed25519 -out " + str(vw.OS_KEY))
 os.chmod(vw.OS_KEY, 0o600)
 pem = run("/usr/bin/openssl", "pkey", "-in", str(vw.OS_KEY), "-pubout").stdout
 der = subprocess.run(["/usr/bin/openssl", "pkey", "-in", str(vw.OS_KEY), "-pubout", "-outform", "DER"],
  check=True, capture_output=True).stdout
 key_id = hashlib.sha256(der).hexdigest()

 mkdir(REGISTRY.parent, 0, 0, 0o755)
 reg = {"schema": "pi.level2.trust.v1", "keys": {key_id: {"role": "verifier", "label": "pi-verifier-os-user",
  "public_pem": pem, "identity": {"mode": "os-user", "user": vw.VERIFIER_USER, "uid": ver.pw_uid,
  "code_sha256": installed_code}}}}
 install_file(REGISTRY, json.dumps(reg, sort_keys=True).encode("ascii"), 0o644)

 rules = ("Defaults:%(b)s !requiretty\n"
  "%(b)s ALL=(%(v)s) NOPASSWD: %(py)s -I -S %(w)s *\n"
  "%(v)s ALL=(root) NOPASSWD: %(rc)s \"\"\n") % {"b": a.broker_user, "v": vw.VERIFIER_USER, "py": SYSTEM_PYTHON,
  "w": vw.INSTALL_DIR / "verifier_worker.py", "rc": vw.CANDIDATE_RUNNER}
 staged = Path("/etc/pi-level2/sudoers.check")
 install_file(staged, rules.encode("ascii"), 0o440)
 run("visudo", "-cf", str(staged))
 os.replace(staged, SUDOERS)

 summary = {"verifier_user": vw.VERIFIER_USER, "verifier_uid": ver.pw_uid, "candidate_user": vw.CANDIDATE_USER,
  "candidate_uid": cand.pw_uid, "broker_user": a.broker_user, "broker_uid": broker.pw_uid, "key_id": key_id,
  "code_sha256": installed_code, "registry": str(REGISTRY), "lockdown": lockdown(a.broker_user) if a.lockdown else None}
 print(json.dumps(summary, sort_keys=True))


if __name__ == "__main__":
 main()
