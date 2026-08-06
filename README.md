# EBA Taxonomy Migrator & Explorer

🚀 **[Live Data Explorer (GitHub Pages)](https://bojaruniec.github.io/eba_taxonomy/)**

This project provides an end-to-end pipeline to migrate the European Banking Authority (EBA) DPM Taxonomy from a legacy MS Access database (`.accdb`) into a modern, web-accessible Parquet Data Explorer.

The project is split into two phases:

## Phase 1: Java Extraction Pipeline
A Java/Maven application that reads the MS Access `.accdb` file and dynamically extracts both its schema and data.
* **Schema Extraction:** Generates standard SQL DDL (`tables.sql` and `foreign_keys.sql`) mapping Jackcess types to SQL types.
* **Data Extraction:** Converts every non-system table into GZIP-compressed Apache Parquet files and generates 20-row CSV samples for quick debugging.
* **Dockerized:** Can be built and run completely within Docker, avoiding local Java/Hadoop environment setup.

## Phase 2: Static Data Explorer (DuckDB-Wasm)
A 100% static, serverless web application that allows users to interactively query the extracted Parquet data directly in their browser.
* **Zero Backend:** Uses [DuckDB-Wasm](https://duckdb.org/docs/api/wasm/overview.html) to run SQL queries locally in the browser.
* **HTTP Range Requests:** Only fetches the specific columns and byte ranges needed from the Parquet files, making it extremely fast even on large datasets.
* **Interactive UI:** Built with Vanilla JS and [Tabulator](https://tabulator.info/), featuring a dark Graphite & Violet theme, built-in CSV export, live SQL editor, and column-level filtering.

## Setup & Usage

### 1. Run the Pipeline (Requires Docker)
Place your target database inside the `inp/` directory, for example: `inp/DPM2 Database_v 4_3_20260622.accdb`.
Then run the Docker Compose pipeline:
```bash
docker compose build
docker compose up
```
This will populate the `out/` directory with `parquet/`, `csv/`, `schema/`, and generate a `run_summary.txt`.

### 2. View the Web UI Locally
Because DuckDB-Wasm requires a web server (to handle HTTP range requests), you cannot just double-click `index.html`. Start a local server in the `out/` directory:
```bash
cd out
python3 -m http.server 8080
```
Then navigate to `http://localhost:8080` in your browser.

### 3. Deploying to GitHub Pages
The web application is fully automated to deploy via GitHub Pages. A GitHub Actions workflow (`.github/workflows/pages.yml`) is included, which automatically bundles and publishes the `out/` directory whenever code is pushed to the `main` branch.

To view the live site, visit: **[https://bojaruniec.github.io/eba_taxonomy/](https://bojaruniec.github.io/eba_taxonomy/)**
