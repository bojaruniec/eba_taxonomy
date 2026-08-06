package org.eba.migrator;

import com.healthmarketscience.jackcess.Column;
import com.healthmarketscience.jackcess.Database;
import com.healthmarketscience.jackcess.DatabaseBuilder;
import com.healthmarketscience.jackcess.Row;
import com.healthmarketscience.jackcess.Table;
import org.apache.commons.csv.CSVFormat;
import org.apache.commons.csv.CSVPrinter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedWriter;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Phase 1: Reads every table from an MS Access (.accdb) database using Jackcess
 * and writes up to MAX_ROWS rows per table as a CSV file into the output directory.
 *
 * Expected environment variables (with defaults for local testing):
 *   DB_PATH  – absolute path to the .accdb file  (default: /app/inp/database.accdb)
 *   OUT_DIR  – directory where CSV files are saved (default: /app/out/csv)
 */
public class AccessToCsvExporter {

    private static final Logger log = LoggerFactory.getLogger(AccessToCsvExporter.class);

    /** Maximum number of data rows exported per table. */
    private static final int MAX_ROWS = 20;

    public static void main(String[] args) {
        String dbPathStr = System.getenv().getOrDefault("DB_PATH", "/app/inp/database.accdb");
        String outDirStr = System.getenv().getOrDefault("OUT_DIR", "/app/out/csv");

        // Allow override via command-line args for quick local testing
        if (args.length >= 1) dbPathStr = args[0];
        if (args.length >= 2) outDirStr = args[1];

        log.info("=== EBA Taxonomy Migrator – Phase 1 ===");
        log.info("Database : {}", dbPathStr);
        log.info("Output   : {}", outDirStr);

        File dbFile = new File(dbPathStr);
        if (!dbFile.exists() || !dbFile.isFile()) {
            log.error("Database file not found: {}", dbPathStr);
            System.exit(1);
        }

        Path outDir = Paths.get(outDirStr);
        try {
            Files.createDirectories(outDir);
            log.info("Output directory ready: {}", outDir.toAbsolutePath());
        } catch (IOException e) {
            log.error("Cannot create output directory '{}': {}", outDirStr, e.getMessage());
            System.exit(1);
        }

        try (Database db = DatabaseBuilder.open(dbFile)) {
            Set<String> tableNames = db.getTableNames();
            log.info("Found {} table(s) in the database.", tableNames.size());

            int successCount = 0;
            int errorCount = 0;

            for (String tableName : tableNames) {
                try {
                    exportTable(db, tableName, outDir);
                    successCount++;
                } catch (Exception e) {
                    log.error("Failed to export table '{}': {}", tableName, e.getMessage(), e);
                    errorCount++;
                }
            }

            log.info("=== Export complete: {} succeeded, {} failed ===", successCount, errorCount);
            if (errorCount > 0) {
                System.exit(2);
            }

        } catch (IOException e) {
            log.error("Cannot open database '{}': {}", dbPathStr, e.getMessage(), e);
            System.exit(1);
        }
    }

    /**
     * Exports up to {@link #MAX_ROWS} rows from the given table to a CSV file.
     *
     * @param db        open Jackcess Database handle
     * @param tableName name of the table to export
     * @param outDir    target directory for the CSV file
     */
    private static void exportTable(Database db, String tableName, Path outDir) throws IOException {
        Table table = db.getTable(tableName);
        List<Column> columns = table.getColumns();

        // Build the header array from column metadata
        String[] headers = columns.stream()
                .map(Column::getName)
                .toArray(String[]::new);

        // Sanitise the table name to create a safe filename
        String safeFileName = tableName.replaceAll("[^a-zA-Z0-9_\\-]", "_") + ".csv";
        Path csvPath = outDir.resolve(safeFileName);

        log.info("Exporting table '{}' -> {}", tableName, csvPath);

        CSVFormat format = CSVFormat.DEFAULT.builder()
                .setHeader(headers)
                .setRecordSeparator("\n")
                .build();

        try (BufferedWriter writer = Files.newBufferedWriter(csvPath);
             CSVPrinter printer = new CSVPrinter(writer, format)) {

            int rowCount = 0;
            for (Row row : table) {
                if (rowCount >= MAX_ROWS) {
                    break;
                }

                List<Object> values = new ArrayList<>(headers.length);
                for (String header : headers) {
                    Object val = row.get(header);
                    values.add(val != null ? val.toString() : "");
                }
                printer.printRecord(values);
                rowCount++;
            }

            log.info("  -> Wrote {} row(s) (limit: {}) for table '{}'", rowCount, MAX_ROWS, tableName);
        }
    }
}