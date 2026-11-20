# Fuel: calorie and macro tracker

Fuel is a personal calorie and macro tracker that you install on your phone like an app.

- **Scan a barcode with your camera.** Fuel checks *your own food library* first, which is instant and works offline. If the barcode isn't there, it looks it up in **Open Food Facts**, a free, open food database.
- **Barcode not found?** Photograph the nutrition panel and Claude reads the numbers. You check them, and Fuel saves the food under that barcode. The next time you scan it, it's recognised instantly.
- **Other ways to add food:** search Open Food Facts by name, pick from your library, quick-add calories, or describe a meal in plain words.
- **Meal photos:** snap your plate (📸 Meal) and Claude estimates each item's calories and macros. You can add notes such as "cooked in olive oil", then check the numbers before adding. This needs the API key.
- **Recipes:** build a recipe from any foods, whether scanned, searched, from your library or typed in. Say how many serves it makes. Optionally weigh the whole pot after cooking, and you can log any portion by grams. Recipes are saved in My foods and logged like any other food.
- **Two themes** (Settings → Theme):
  - **Bento:** Japanese style with an onigiri mascot. Your meals sit in the compartments of a lacquered bento box.
  - **Menażka:** Polish style with a pierogi mascot in a flower crown. Your meals sit in the tiers of an enamel lunch carrier.

  In both, the mascot cheers you on and looks worried if you go over your calories. Tap any compartment or tier to see, add or delete that meal's foods.
- **Your day:** calories left, protein/carbs/fat bars and meals. You can copy a meal from yesterday or log your morning weight.
- **Your week:** a chart, daily totals, averages and a weekly summary you can copy.

All your data is stored on your phone. Use **Settings → Export backup** now and then.

---

## 1. Put it online (free, about 5 minutes, needs a computer once)

Your phone only allows camera access for websites served over `https://`. GitHub Pages provides that for free.

1. Create a free account at **github.com** if you don't have one.
2. Click **+ → New repository**. Name it `fuel`, set it to **Public**, and click **Create repository**.
3. On the new repo's page, click **uploading an existing file**. Drag in **every file in this folder**: `index.html`, `app.js`, `sw.js`, `manifest.webmanifest`, `zxing.min.js`, `icon-192.png`, `icon-512.png` (and this README if you like). Click **Commit changes**.
4. Go to **Settings → Pages**. Under *Branch*, choose **main** and **/ (root)**, then click **Save**.
5. Wait about a minute. Your app will be at **`https://YOUR-USERNAME.github.io/fuel/`**.

## 2. Install it on your phone

- **iPhone:** open the link in **Safari** → Share button → **Add to Home Screen**.
- **Android:** open it in **Chrome** → ⋮ menu → **Install app**.

The first time you tap **Scan**, allow camera access.

## 3. Turn on label reading (optional, recommended)

Reading label photos and the "Describe it" feature use Claude through your own API key.

1. Go to **console.anthropic.com**, sign up, and add a small amount of credit (US$5 lasts a long time).
2. Under **Settings → Limits**, set a low monthly spend limit, e.g. $5.
3. Go to **API keys → Create key** and copy it.
4. In Fuel: **Settings → Label reading** → paste the key → **Test**.

Each label read costs roughly a cent or less. The key is stored only on your phone and is never included in backups. Don't put the key in any file you upload to GitHub.

Without a key, everything else still works. For barcodes that aren't in the database, you type the numbers in yourself while looking at your photo.

---

## Tips

- Australian labels show energy in **kJ**. When typing values yourself, set *Energy unit* to **kJ** and Fuel converts it.
- Open Food Facts is crowd-sourced, so check the numbers against the pack the first time. Tap **"Numbers wrong? Edit this food"** to fix them, and your corrected version is what you'll get from then on.
- Searching Open Food Facts is limited to about 10 searches a minute. Barcode lookups are fine.

## Updating the app

To change the app, edit the files and upload the new versions to the same GitHub repo. Then change `VERSION` in `sw.js` (e.g. `fuel-v2`) so phones pick up the update. Your logged data isn't affected.

## How it's built

`app.js` is plain JavaScript with no frameworks and no build step. Barcode reading uses the phone's built-in barcode detector where available (Android) and the bundled ZXing library everywhere else (iPhone). ZXing is Apache-2.0 licensed; see `zxing-LICENSE`. Food data comes from Open Food Facts under the ODbL licence.
