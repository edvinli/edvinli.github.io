# edvinli.github.io

Source for my personal website, <https://edvinli.github.io> — a Jekyll site based on
the [academicpages](https://github.com/academicpages/academicpages.github.io) fork of
[Minimal Mistakes](https://github.com/mmistakes/minimal-mistakes).

## Layout

| Path | Contents |
| :--- | :--- |
| `_pages/` | Standalone pages (about, cv, publications, students, industry, …) |
| `_layouts/`, `_includes/`, `_sass/` | Theme templates and styles |
| `_data/` | Navigation and UI text |
| `assets/` | CSS, JS, fonts and page data |
| `files/` | Downloadable files, BibTeX stubs and published election-forecast JSON |
| `images/` | Images used across the site |

## Building locally

With Jekyll installed locally:

```bash
jekyll serve --config _config.yml,_config.dev.yml
```

The site is then served at <http://localhost:4000>.

## Election forecast

The Swedish Riksdag election model — its source code, datasets, documentation and
test suite — lives in its own repository:

**<https://github.com/edvinli/election-simulator>**

This repository only carries the *published output* of that model, under
`files/election-simulator/`:

- `versions/<generation>/` — immutable, hash-manifested publication generations
- `current.json` — pointer to the live generation
- the flat `forecast.json`, `parties.json`, `seats.json`, `groups.json`,
  `calibration.json`, `metadata.json` and `manifest.json` files, kept as a
  backward-compatible fallback for older consumers

These artifacts are generated and hashed upstream. Do not hand-edit them; publish a
new generation from the election-simulator repository instead.
