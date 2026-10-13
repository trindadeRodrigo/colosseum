// Run by check-frames.mjs against the production build it starts: every icon the app names answers,
// in its type and size, and a page's head links them (app/icon.svg, app/favicon.ico,
// app/apple-icon.png, app/manifest.ts, app/opengraph-image.tsx; scripts/make-icons.mjs).

/** The PNG's width and height, from its header. */
const pngSize = (bytes) => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];

/** What is wrong with the icons on `base`; empty when nothing is. */
export async function iconProblems(base) {
  const problems = [];
  const get = async (path, type) => {
    const answer = await fetch(base + path);
    const bytes = Buffer.from(await answer.arrayBuffer());
    if (answer.status !== 200 || !answer.headers.get('content-type')?.startsWith(type)) {
      problems.push(`${path}: ${answer.status} ${answer.headers.get('content-type')}, not ${type}`);
      return null;
    }
    return bytes;
  };
  const svg = await get('/icon.svg', 'image/svg+xml');
  // the face reads in a light tab and a dark one alike (ink on honey, LOGO-2): it is the honey tile
  if (svg && !/fill="#F5A83A"/i.test(svg.toString()))
    problems.push('/icon.svg is not the honey tile');
  const ico = await get('/favicon.ico', 'image/x-icon');
  if (ico) {
    const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + 16 * i]);
    if (ico.readUInt16LE(2) !== 1 || sizes.join() !== '16,32,48')
      problems.push(`/favicon.ico holds ${sizes.join(', ')} px, not 16, 32 and 48`);
  }
  for (const [path, size] of [
    ['/apple-icon.png', 180],
    ['/opengraph-image', 1200],
  ]) {
    const png = await get(path, 'image/png');
    if (png && pngSize(png)[0] !== size)
      problems.push(`${path} is ${pngSize(png)[0]} px wide, not ${size}`);
  }
  const manifest = await get('/manifest.webmanifest', 'application/manifest+json');
  if (manifest) {
    const { name, icons = [] } = JSON.parse(manifest.toString());
    if (name !== 'tenonfi') problems.push(`the manifest's name is ${name}`);
    for (const icon of icons) {
      const png = await get(icon.src, 'image/png');
      if (png && `${pngSize(png).join('x')}` !== icon.sizes)
        problems.push(`${icon.src} is ${pngSize(png).join('x')}, the manifest says ${icon.sizes}`);
    }
    if (icons.length < 2) problems.push('the manifest names fewer than two icons');
  }
  for (const page of ['/', '/goal']) {
    const head = (await (await fetch(base + page)).text()).split('</head>')[0];
    for (const [what, link] of [
      [
        'the SVG icon',
        /<link rel="icon" href="\/icon\.svg[^"]*" sizes="any" type="image\/svg\+xml"/,
      ],
      ['the .ico', /<link rel="icon" href="\/favicon\.ico[^"]*" sizes="48x48"/],
      [
        'the Apple icon',
        /<link rel="apple-touch-icon" href="\/apple-icon\.png[^"]*" sizes="180x180"/,
      ],
      ['the manifest', /<link rel="manifest" href="\/manifest\.webmanifest"/],
      ['the preview image', /<meta property="og:image" content="[^"]*\/opengraph-image[^"]*"/],
      ['the bar colour', /<meta name="theme-color" content="#0C0D12"/],
    ])
      if (!link.test(head)) problems.push(`${page}'s head has no link to ${what}`);
  }
  return problems;
}
