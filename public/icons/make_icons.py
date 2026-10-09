#!/usr/bin/env python3
"""Gera os icones PNG do app (sem dependencias externas)."""
import struct
import zlib
import os

OUT = os.path.dirname(os.path.abspath(__file__))


def lerp(a, b, t):
    return a + (b - a) * t


def rrect_in(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def tri_in(px, py, a, b, c):
    def sign(p, q, r):
        return (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])

    d1 = sign((px, py), a, b)
    d2 = sign((px, py), b, c)
    d3 = sign((px, py), c, a)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def sample(u, v, S):
    """u,v em 0..1 -> RGBA"""
    x, y = u * S, v * S
    bg = (11, 15, 23)

    # moldura da TV
    if rrect_in(x, y, 0.12 * S, 0.21 * S, 0.88 * S, 0.70 * S, 0.055 * S):
        t = (x + y) / (2 * S)
        col = (int(lerp(46, 59, t)), int(lerp(230, 130, t)), int(lerp(168, 246, t)))
        # triangulo de play
        if tri_in(
            x,
            y,
            (0.44 * S, 0.375 * S),
            (0.44 * S, 0.535 * S),
            (0.66 * S, 0.455 * S),
        ):
            return (11, 15, 23, 255)
        return (*col, 255)

    # pes
    if rrect_in(x, y, 0.34 * S, 0.755 * S, 0.66 * S, 0.805 * S, 0.012 * S):
        return (46, 230, 168, 255)
    if rrect_in(x, y, 0.18 * S, 0.815 * S, 0.31 * S, 0.87 * S, 0.012 * S):
        return (46, 230, 168, 255)
    if rrect_in(x, y, 0.69 * S, 0.815 * S, 0.82 * S, 0.87 * S, 0.012 * S):
        return (59, 130, 246, 255)

    return (*bg, 255)


def render(S, samples=3):
    rows = []
    step = 1.0 / (S * samples)
    for py in range(S):
        row = bytearray([0])
        for px in range(S):
            acc = [0, 0, 0, 0]
            for sy in range(samples):
                for sx in range(samples):
                    u = (px + (sx + 0.5) / samples) / S
                    v = (py + (sy + 0.5) / samples) / S
                    c = sample(u, v, S)
                    acc[0] += c[0]
                    acc[1] += c[1]
                    acc[2] += c[2]
                    acc[3] += c[3]
            n = samples * samples
            row += bytes([acc[0] // n, acc[1] // n, acc[2] // n, acc[3] // n])
        rows.append(bytes(row))
    return zlib.compress(b"".join(rows), 9)


def write_png(path, size):
    raw = render(size)
    chunks = []
    for tag, data in (
        (b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)),
        (b"IDAT", raw),
        (b"IEND", b""),
    ):
        chunks.append(struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + b"".join(chunks))
    print("gerado", path, os.path.getsize(path), "bytes")


for name, size in (
    ("icon-192.png", 192),
    ("icon-512.png", 512),
    ("icon-maskable-512.png", 512),
    ("favicon-32.png", 32),
):
    write_png(os.path.join(OUT, name), size)