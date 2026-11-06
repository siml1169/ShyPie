# ShyPie brand assets

The selected ShyPie mark: a complete, uncut pie holding a shield with a generic bird.

## Files

| Path | Use |
|---|---|
| `svg/shypie-icon.svg` | Primary vector, mint background |
| `svg/shypie-icon-transparent.svg` | Same mark, transparent background |
| `svg/shypie-icon-dark.svg` | Dark-background variant with cream outlines |
| `svg/shypie-icon-mono.svg` | One-color line/mono mark, transparent |
| `svg/shypie-icon-simple.svg` | Reduced small-size mark |
| `svg/shypie-icon-maskable.svg` | 80% safe-area version for maskable icons |
| `png/shypie-icon-{1024,512,256,128,64,32,16}.png` | Primary PNG exports |
| `png/shypie-icon-{variant}-*.png` | Dark / mono / transparent / simple exports |
| `favicon/favicon.ico` | Multi-size favicon (16/32/48/64) |
| `favicon/favicon-{16,32,48,64}.png` | Favicon PNGs |
| `favicon/favicon.svg` | Scalable favicon (simplified mark) |
| `platform/apple-touch-icon-180.png` | iOS home screen |
| `platform/android-chrome-{192,512}.png` | Android home screen |
| `platform/maskable-512.png` | Android maskable icon |
| `site.webmanifest` | Web app manifest |
| `preview.png` | Contact sheet of the variants |

## Palette

| Token | Hex |
|---|---|
| Mint background | `#EAF7F0` |
| Deep teal / ink | `#0D4B4E` |
| Shield outline | `#08383B` |
| Golden crust | `#F2B35A` |
| Cream filling | `#FFF2D8` |
| Bird mark | `#F7E9C6` |
| Blush | `#F08074` |
| Dark background | `#062F33` |

## Web usage

```html
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48 64x64">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/apple-touch-icon-180.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#0D4B4E">
```

The manifest expects its icons at `platform/…` relative to the manifest. Adjust those paths if the files are copied into a different web root.

## Small sizes

Use `shypie-icon-simple.svg` / `favicon.svg` below 48px. The complete illustration is still readable at 48–64px, but the eyes, hands and bird collapse into texture at 16–32px; the simplified mark keeps the pie ring, shield silhouette and bird mass.

## Bird mark

The bird on the shield is a generic silhouette created for this mark. The ShyPie
name and logo belong to the ShyPie project.
