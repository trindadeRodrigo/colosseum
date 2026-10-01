# Generates plain-sawn side-grain and end-grain wood textures (colour + bump) for the 3D hero prototype.
# Colours sampled from visual-refferences/master.jpg.
import numpy as np
from PIL import Image, ImageFilter
OUT = '/Users/rodrigo/Documents/Colosseum-design/.design/branding/working-brand/patterns/prototypes/assets/'
N = 1024
rng = np.random.default_rng(7)

def vnoise(shape, cells, seed):
    r = np.random.default_rng(seed)
    gy, gx = cells
    g = r.random((gy + 1, gx + 1))
    g[-1, :] = g[0, :]; g[:, -1] = g[:, 0]          # tileable
    h, w = shape
    y = np.linspace(0, gy, h, endpoint=False); x = np.linspace(0, gx, w, endpoint=False)
    yi = y.astype(int); xi = x.astype(int)
    fy = (y - yi)[:, None]; fx = (x - xi)[None, :]
    fy = fy * fy * (3 - 2 * fy); fx = fx * fx * (3 - 2 * fx)
    a = g[yi][:, xi]; b = g[yi][:, xi + 1]; c = g[yi + 1][:, xi]; d = g[yi + 1][:, xi + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy

def fbm(shape, cells, seed, oct=5):
    s = np.zeros(shape); amp = 1; tot = 0
    for o in range(oct):
        s += amp * vnoise(shape, (cells[0] * 2 ** o, cells[1] * 2 ** o), seed + o); tot += amp; amp *= 0.5
    return s / tot

def side(base, late, light, seed, rings=9.0):
    # Rift/quarter-sawn look as in master.jpg: fine straight streaks along the grain, soft wide bands, faint pores.
    v = np.linspace(0, 1, N, endpoint=False)[:, None] * np.ones((1, N))
    warp = fbm((N, N), (2, 3), seed, 4) * 0.35                  # gentle drift only
    r = (v * rings + warp) % 1.0
    band = np.clip(np.sin(r * 2 * np.pi) * 0.5 + 0.5, 0, 1) ** 3  # soft latewood bands
    fine = fbm((N, N), (180, 3), seed + 100, 3)                 # very fine streaks, long along u
    mid = fbm((N, N), (40, 4), seed + 150, 3)
    tone = fbm((N, N), (2, 2), seed + 200, 3)
    pores = (vnoise((N, N), (300, 30), seed + 300) > 0.9).astype(float)
    pores = np.asarray(Image.fromarray((pores * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))) / 255.0
    t = np.clip(0.18 + band * 0.32 + (fine - 0.5) * 0.9 + (mid - 0.5) * 0.45 + (tone - 0.5) * 0.25, 0, 1)
    col = base[None, None] * (1 - t[..., None]) + late[None, None] * t[..., None]
    hi = np.clip((0.42 - fine) * 1.5, 0, 0.3)
    col = col * (1 - hi[..., None]) + light[None, None] * hi[..., None]
    col = col * (1 - pores[..., None] * 0.1)
    bump = np.clip(0.5 + (fine - 0.5) * 0.8 + band * 0.1 - pores * 0.3, 0, 1)
    return col, bump

def end(base, late, light, seed, rings=34):
    y, x = np.mgrid[0:N, 0:N] / N
    cx, cy = -0.6, 1.5                                          # pith well off the board
    d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2)
    n = fbm((N, N), (3, 3), seed, 4)
    spacing = d * rings + n * 1.4 + fbm((N, N), (2, 2), seed + 3, 2) * 3.0   # uneven ring widths
    r = spacing % 1.0
    band = np.clip((r - 0.8) / 0.15, 0, 1)                     # thin latewood lines
    grain = fbm((N, N), (140, 140), seed + 9, 2)
    t = np.clip(0.15 + band * 0.45 + (grain - 0.5) * 0.5, 0, 1)
    col = base[None, None] * (1 - t[..., None]) + late[None, None] * t[..., None]
    col *= (0.94 + 0.06 * grain)[..., None]
    bump = np.clip(0.5 + (grain - 0.5) * 0.7 - band * 0.15, 0, 1)
    return col, bump

def save(name, col, bump):
    Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)).save(OUT + name + '.jpg', quality=88)
    Image.fromarray((bump * 255).astype(np.uint8)).resize((512, 512)).save(OUT + name + '-bump.jpg', quality=85)

C = lambda *a: np.array(a, float)
# darker hardwood (master.jpg left member, pinkish oak/mahogany)
save('hardwood-side', *side(C(178, 128, 90), C(118, 76, 46), C(214, 172, 132), 11, rings=7.5))
save('hardwood-end', *end(C(170, 120, 82), C(112, 72, 42), C(205, 160, 120), 12))
# pale hinoki / spruce (master.jpg right post)
save('hinoki-side', *side(C(232, 212, 176), C(196, 166, 120), C(244, 230, 204), 21, rings=6.0))
save('hinoki-end', *end(C(226, 204, 166), C(190, 158, 112), C(240, 224, 196), 22))
print('ok')
