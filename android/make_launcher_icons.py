#!/usr/bin/env python3
"""Gera os icones do launcher (Android) a partir da mesma arte do PWA."""
import struct
import zlib
import os

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "res")


def lerp(a, b, t):
    return a + (b - a) * t


def rrect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def tri(px, py, a, b, c):
    def s(p, q, r):
        return (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])

    d1, d2, d3 = s((px, py), a, b), s((px, py), b, c), s((px, py), c, a)
    return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))


def artwork(x, y, S):
    """Desenha a arte em coordenadas 0..S. Devolve RGBA ou None."""
    if rrect(x, y, 0.12 * S, 0.21 * S, 0.88 * S, 0.70 * S, 0.055 * S):
        t = (x + y) / (2 * S)
        col = (
            int(lerp(46, 59, t)),
            int(lerp(230, 130, t)),
            int(lerp(168, 246, t)),
        )
        if tri(x, y, (0.44 * S, 0.375 * S), (0.44 * S, 0.535 * S), (0.66 * S, 0.455 * S)):
            return (11, 15, 23, 255)
        return (*col, 255)
    if rrect(x, y, 0.34 * S, 0.755 * S, 0.66 * S, 0.805 * S, 0.012 * S):
        return (46, 230, 168, 255)
    if rrect(x, y, 0.18 * S, 0.815 * S, 0.31 * S, 0.87 * S, 0.012 * S):
        return (46, 230, 168, 255)
    if rrect(x, y, 0.69 * S, 0.815 * S, 0.82 * S, 0.87 * S, 0.012 * S):
        return (59, 130, 246, 255)
    return None


def sample(u, v, S, adaptive):
    if not adaptive:
        return artwork(u * S, v * S, S) or (11, 15, 23, 255)
    # camada adaptativa: 62% do artwork, centralizado, fundo transparente
    k = 0.62
    uu = (u - 0.5) / k + 0.5
    vv = (v - 0.5) / k + 0.5
    if uu < 0 or uu > 1 or vv < 0 or vv > 1:
        return (0, 0, 0, 0)
    return artwork(uu * S, vv * S, S) or (0, 0, 0, 0)


def render(S, adaptive=False, ss=3):
    rows = []
    for py in range(S):
        row = bytearray([0])
        for px in range(S):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    c = sample((px + (sx + 0.5) / ss) / S, (py + (sy + 0.5) / ss) / S, S, adaptive)
                    for i in range(4):
                        acc[i] += c[i]
            n = ss * ss
            row += bytes([acc[i] // n for i in range(4)])
        rows.append(bytes(row))
    return zlib.compress(b"".join(rows), 9)


def write(path, size, adaptive=False):
    data = render(size, adaptive)
    parts = []
    for tag, d in (
        (b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)),
        (b"IDAT", data),
        (b"IEND", b""),
    ):
        crc = zlib.crc32(tag + d) & 0xFFFFFFFF
        parts.append(struct.pack(">I", len(d)) + tag + d + struct.pack(">I", crc))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + b"".join(parts))
    print("  ", os.path.relpath(path, HERE), size, "adaptivo" if adaptive else "")


DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

print("gerando icones do launcher")
for dens, size in DENSITIES.items():
    d = os.path.join(RES, "mipmap-" + dens)
    write(os.path.join(d, "ic_launcher.png"), size)
    write(os.path.join(d, "ic_launcher_round.png"), size)
    write(os.path.join(d, "ic_launcher_foreground.png"), int(size * 2.25), adaptive=True)