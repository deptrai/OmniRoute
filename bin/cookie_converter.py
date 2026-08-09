#!/usr/bin/env python3
"""
Cookie Converter — chuyen doi cookie tu format "userID:random:base64" sang "userID|random|decoded_cookie".

Usage:
  python3 cookie_converter.py input.txt
  -> tu tao output.txt (ghi de neu co roi)
"""

import base64
import sys
import os

def convert_one(raw: str) -> str | None:
    """Convert 1 dong: userID:random:base64 -> userID|random|decoded"""
    raw = raw.strip()
    if not raw:
        return None

    parts = raw.split(":", 2)
    if len(parts) < 3:
        print(f"SKIP (khong du 3 phan cach ':'): {raw[:60]}...", file=sys.stderr)
        return None

    user_id, random_str, b64_cookie = parts
    try:
        decoded = base64.b64decode(b64_cookie).decode("utf-8")
        return f"{user_id}|{random_str}|{decoded}"
    except Exception as e:
        print(f"SKIP (base64 decode loi): {e} — {raw[:60]}...", file=sys.stderr)
        return None


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 cookie_converter.py input.txt")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = "output.txt"

    if not os.path.exists(input_file):
        print(f"Loi: file khong ton tai — {input_file}", file=sys.stderr)
        sys.exit(1)

    with open(input_file, "r", encoding="utf-8") as f:
        lines = [line.strip() for line in f if line.strip()]

    if not lines:
        print("File input rong.", file=sys.stderr)
        sys.exit(1)

    results = []
    for raw in lines:
        cookie = convert_one(raw)
        if cookie:
            results.append(cookie)

    with open(output_file, "w", encoding="utf-8") as f:
        f.write("\n".join(results) + "\n")

    print(f"Da convert {len(results)}/{len(lines)} cookie -> {output_file}", file=sys.stderr)


if __name__ == "__main__":
    main()
