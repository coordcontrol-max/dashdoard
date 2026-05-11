"""Gera os ícones do PWA (192, 512, e 512 maskable).

Visual: quadrado verde escuro com gradiente diagonal (mesma paleta do header
do dashboard) + ícone de gráfico de linhas em amarelo (mesmo do login).

Roda só uma vez: python3 _make_icons.py. Pode apagar depois se quiser.
"""
from PIL import Image, ImageDraw

GREEN_TOP    = (31, 90, 68)    # #1f5a44
GREEN_BOTTOM = (6, 36, 24)     # #062418
ACCENT       = (255, 210, 74)  # #ffd24a (amarelo)


def linear_gradient(size, top, bottom):
    img = Image.new("RGB", (size, size), top)
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        r = int(top[0] * (1 - t) + bottom[0] * t)
        g = int(top[1] * (1 - t) + bottom[1] * t)
        b = int(top[2] * (1 - t) + bottom[2] * t)
        for x in range(size):
            px[x, y] = (r, g, b)
    return img


def draw_chart_icon(draw, cx, cy, radius, color, stroke):
    """Desenha o ícone de gráfico (eixos + linha) centralizado em (cx, cy).
    radius = "raio" do bounding-box (metade do lado).
    """
    s = radius
    # Eixos em forma de L (canto inferior esquerdo)
    p_axis = [
        (cx - s,        cy - s),    # topo do eixo Y
        (cx - s,        cy + s),    # canto
        (cx + s,        cy + s),    # ponta direita do eixo X
    ]
    draw.line(p_axis, fill=color, width=stroke, joint="curve")

    # Linha quebrada (gráfico) dentro dos eixos
    pad = int(s * 0.25)
    pts = [
        (cx - s + pad,            cy + int(s * 0.35)),
        (cx - int(s * 0.20),      cy - int(s * 0.10)),
        (cx + int(s * 0.10),      cy + int(s * 0.15)),
        (cx + s - pad,            cy - int(s * 0.55)),
    ]
    draw.line(pts, fill=color, width=stroke, joint="curve")

    # Pontinhos nos vértices da linha
    dot = max(stroke + 1, int(s * 0.06))
    for (x, y) in pts:
        draw.ellipse((x - dot, y - dot, x + dot, y + dot), fill=color)


def make_icon(size, maskable=False):
    img = linear_gradient(size, GREEN_TOP, GREEN_BOTTOM)

    # Para maskable, o conteúdo precisa caber no "safe area" (~80% central).
    safe = 0.66 if maskable else 0.78
    cx = cy = size // 2
    radius = int(size * safe / 2)
    stroke = max(4, size // 32)

    # Para PWAs com cantos arredondados (não-maskable), recorta os cantos.
    draw = ImageDraw.Draw(img)
    draw_chart_icon(draw, cx, cy, radius, ACCENT, stroke)

    if not maskable:
        # Aplica máscara de cantos arredondados via alpha
        rgba = img.convert("RGBA")
        mask = Image.new("L", (size, size), 0)
        mdraw = ImageDraw.Draw(mask)
        mdraw.rounded_rectangle((0, 0, size, size), radius=int(size * 0.22), fill=255)
        rgba.putalpha(mask)
        return rgba

    return img.convert("RGBA")


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(__file__), "icons")
    os.makedirs(out, exist_ok=True)

    make_icon(192).save(os.path.join(out, "icon-192.png"), "PNG")
    make_icon(512).save(os.path.join(out, "icon-512.png"), "PNG")
    make_icon(512, maskable=True).save(os.path.join(out, "icon-maskable-512.png"), "PNG")
    print("Ícones gerados em:", out)
