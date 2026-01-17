import sys


def main() -> int:
    args = sys.argv[1:]
    if len(args) < 3 or args[0] != "predict-prob":
        sys.stderr.write("Usage: fasttext predict-prob <model> - [k]\n")
        return 1

    model_path = args[1]
    try:
        k = int(args[3]) if len(args) > 3 else 1
    except ValueError:
        k = 1

    try:
        import fasttext
    except ImportError:
        sys.stderr.write("fasttext module not found. Install fasttext-wheel.\n")
        return 1

    text = sys.stdin.read()
    text = " ".join(text.split())
    if not text:
        return 1

    model = fasttext.load_model(model_path)
    labels, probs = model.predict(text, k=k)
    for label, prob in zip(labels, probs):
        sys.stdout.write(f"{label} {prob}\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
