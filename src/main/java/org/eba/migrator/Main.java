package org.eba.migrator;

import com.healthmarketscience.jackcess.Database;
import com.healthmarketscience.jackcess.DatabaseBuilder;
import com.healthmarketscience.jackcess.Table;
import org.apache.avro.Schema;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Map;
import java.util.Set;

/**
 * Entry point for the EBA Taxonomy Migrator – Phase 1.
 *
 * <p>Orchestrates three sequential phases for every non-system table
 * (tables whose names start with {@code ~} are skipped throughout):
 *
 * <ol>
 *   <li><b>DDL extraction</b> – writes {@code tables.sql} and
 *       {@code foreign_keys.sql} to {@code /app/out/schema/}.</li>
 *   <li><b>Avro schema export</b> – writes one {@code <Table>.avsc} file per
 *       table to {@code /app/out/schema/avro/} for audit / debugging.</li>
 *   <li><b>Data extraction</b> – for each table:
 *       <ul>
 *         <li>CSV sample (≤ 20 rows) → {@code /app/out/csv/}</li>
 *         <li>Full Parquet file (all rows) → {@code /app/out/parquet/}</li>
 *       </ul></li>
 * </ol>
 *
 * <p>Configuration via environment variables (Docker-friendly):
 * <pre>
 *   DB_PATH  – absolute path to the .accdb file  (default: /app/inp/database.accdb)
 *   OUT_DIR  – base output directory             (default: /app/out)
 * </pre>
 * Both can be overridden by positional CLI arguments for local testing.
 */
public class Main {

    private static final Logger log = LoggerFactory.getLogger(Main.class);

    public static void main(String[] args) {
        // Suppress Hadoop's native-library warning on Alpine – purely cosmetic
        System.setProperty("org.apache.hadoop.io.nativeio.NativeIO", "false");

        String dbPathStr = System.getenv().getOrDefault("DB_PATH", "/app/inp/database.accdb");
        String outDirStr = System.getenv().getOrDefault("OUT_DIR",  "/app/out");

        if (args.length >= 1) dbPathStr = args[0];
        if (args.length >= 2) outDirStr = args[1];

        log.info("══════════════════════════════════════════");
        log.info(" EBA Taxonomy Migrator – Phase 1");
        log.info("══════════════════════════════════════════");
        log.info("Database : {}", dbPathStr);
        log.info("Output   : {}", outDirStr);

        // ── Validate input ────────────────────────────────────────────────────
        File dbFile = new File(dbPathStr);
        if (!dbFile.exists() || !dbFile.isFile()) {
            log.error("Database file not found: {}", dbPathStr);
            System.exit(1);
        }

        // ── Create output directories ─────────────────────────────────────────
        Path outDir     = Paths.get(outDirStr);
        Path schemaDir  = outDir.resolve("schema");
        Path avroDir    = schemaDir.resolve("avro");
        Path csvDir     = outDir.resolve("csv");
        Path parquetDir = outDir.resolve("parquet");

        try {
            Files.createDirectories(schemaDir);
            Files.createDirectories(avroDir);
            Files.createDirectories(csvDir);
            Files.createDirectories(parquetDir);
            log.info("Output directories ready.");
        } catch (IOException e) {
            log.error("Cannot create output directories: {}", e.getMessage());
            System.exit(1);
        }

        // ── Open database and run all phases ──────────────────────────────────
        try (Database db = DatabaseBuilder.open(dbFile)) {
            Set<String> allTableNames = db.getTableNames();
            log.info("Discovered {} table(s) in the database.", allTableNames.size());

            // ─────────────────────────────────────────────────────────────────
            // Phase 1a – DDL schema extraction
            // ─────────────────────────────────────────────────────────────────
            log.info("─── Phase 1a: DDL & Avro schema extraction ───");
            Map<String, Schema> avroSchemas =
                    SchemaExtractor.extractDDL(db, allTableNames, schemaDir);

            for (Map.Entry<String, Schema> entry : avroSchemas.entrySet()) {
                try {
                    SchemaExtractor.exportAvroSchema(entry.getKey(), entry.getValue(), avroDir);
                } catch (Exception e) {
                    log.warn("Could not write .avsc for '{}': {}", entry.getKey(), e.getMessage());
                }
            }
            log.info("Exported {} Avro schema file(s) to {}", avroSchemas.size(), avroDir);

            // ─────────────────────────────────────────────────────────────────
            // Phase 1a.2 – Native Relationship extraction
            // ─────────────────────────────────────────────────────────────────
            log.info("─── Phase 1a.2: Native Foreign Key extraction ───");
            try {
                RelationshipExtractor.extractRelationships(db, parquetDir);
            } catch (Exception e) {
                log.error("Failed to extract relationships natively: {}", e.getMessage(), e);
            }

            // ─────────────────────────────────────────────────────────────────
            // Phase 1b – Data extraction (CSV sample + full Parquet)
            // ─────────────────────────────────────────────────────────────────
            log.info("─── Phase 1b: Data extraction (CSV + Parquet) ───");

            int successCount = 0;
            int skippedCount = 0;
            int errorCount   = 0;

            for (String tableName : allTableNames) {

                // Skip Access system / temp tables (names start with ~)
                if (tableName.startsWith("~")) {
                    log.info("Skipping system table: {}", tableName);
                    skippedCount++;
                    continue;
                }

                Schema avroSchema = avroSchemas.get(tableName);
                if (avroSchema == null) {
                    log.warn("No Avro schema found for '{}' – skipping data export.", tableName);
                    skippedCount++;
                    continue;
                }

                try {
                    log.info("Exporting '{}'…", tableName);
                    Table table = db.getTable(tableName);
                    DataExtractor.exportTable(table, avroSchema, csvDir, parquetDir);
                    successCount++;
                } catch (Exception e) {
                    log.error("Export failed for '{}': {}", tableName, e.getMessage(), e);
                    errorCount++;
                }
            }

            log.info("══════════════════════════════════════════");
            log.info(" Export complete: {} ok | {} skipped | {} failed",
                    successCount, skippedCount, errorCount);
            log.info("══════════════════════════════════════════");

            if (errorCount > 0) {
                System.exit(2);
            }

        } catch (IOException e) {
            log.error("Cannot open database '{}': {}", dbPathStr, e.getMessage(), e);
            System.exit(1);
        }
    }
}