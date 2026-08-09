# Cookie Converter

Chuyển cookie từ `userID:random:base64` → cookie string.

## Dùng

```bash
# 1 cookie
python3 bin/cookie_converter.py "61589914482544:ajcnirls20:ZGF0cj1..."

# Batch từ file → file
python3 bin/cookie_converter.py -f input.txt -o output.txt

# Batch qua pipe
cat input.txt | python3 bin/cookie_converter.py

# Xuất kèm userID
python3 bin/cookie_converter.py -f input.txt --with-id

# Copy vào clipboard (macOS)
python3 bin/cookie_converter.py -f input.txt | pbcopy
```

File input: mỗi dòng 1 cookie.

## Flag

| Flag        | Ý nghĩa                   |
| ----------- | ------------------------- |
| `-f FILE`   | File input                |
| `-o FILE`   | File output               |
| `--with-id` | Xuất kèm `userID: cookie` |
| `--help`    | Trợ giúp                  |

Dòng lỗi tự skip, không ảnh hưởng kết quả.
