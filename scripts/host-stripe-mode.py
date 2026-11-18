# costcap#252: declare COSTCAP_STRIPE_MODE in the host .env so it matches the Stripe key
# that is already there. It never adds, removes or swaps a key and never prints a value.
# Usage: python3 host-stripe-mode.py <live|test> [env path]
# Exit 0: mode set (or already set). Exit 2: refused, file unchanged.
import os, sys, time, pathlib, tempfile

def key_class(key):
    if key.startswith(("sk_live_", "rk_live_")):
        return "live"
    if key.startswith("sk_test_"):  # the preflight accepts only sk_test_ in test mode
        return "test"
    return None

def main(argv):
    if len(argv) < 2 or argv[1] not in ("live", "test"):
        print("stripe-mode: usage: host-stripe-mode.py <live|test> [env path]", file=sys.stderr)
        return 2
    want = argv[1]
    path = pathlib.Path(argv[2] if len(argv) > 2 else "/opt/costcap/.env")
    if not path.is_file():
        print("stripe-mode: env file not found", file=sys.stderr)
        return 2
    lines = path.read_text().splitlines()
    env = {}
    # Same parsing as the preflight in scripts/deploy-remote.sh, so a declared mode passes it.
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        k, v = stripped.split("=", 1)
        env[k] = v
    have = key_class(env.get("COSTCAP_STRIPE_SECRET_KEY", ""))
    if have is None:
        print("stripe-mode: refused: no recognizable Stripe key in the host .env; nothing to declare", file=sys.stderr)
        return 2
    if have != want:
        print(f"stripe-mode: refused: the host key is a {have} key; declaring {want} would not match it (keys are never changed here)", file=sys.stderr)
        return 2
    if env.get("COSTCAP_STRIPE_MODE") == want:
        print(f"stripe-mode: already {want}; unchanged")
        return 0
    kept = [l for l in lines if l.strip().split("=", 1)[0] != "COSTCAP_STRIPE_MODE"]
    backup = path.with_name(path.name + ".bak-" + str(int(time.time())))
    backup.write_text(path.read_text())
    os.chmod(backup, 0o600)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".env.tmp-")
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(kept + ["COSTCAP_STRIPE_MODE=" + want]) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    print(f"stripe-mode: set {want} (matches the {have} key already on the host; backup {backup.name})")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv))
