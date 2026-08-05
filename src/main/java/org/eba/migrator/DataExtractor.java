package org.eba.migrator;

import com.healthmarketscience.jackcess.Column;
import com.healthmarketscience.jackcess.Row;
import com.healthmarketscience.jackcess.Table;
import org.apache.avro.Schema;
import org.apache.avro.generic.GenericData;
import org.apache.avro.generic.GenericRecord;
import org.apache.commons.csv.CSVFormat;
import org.apache.commons.csv.CSVPrinter;
import org.apache.hadoop.conf.Configuration;
import org.apache.parquet.avro.AvroParquetWriter;
import org.apache.parquet.hadoop.ParquetFileWriter;
import org.apache.parquet.hadoop.ParquetWriter;
import org.apache.parquet.hadoop.metadata.CompressionCodecName;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Exports a single Access table into two formats in a single pass over the rows:
 *
 * <ul>
 *   <li><b>CSV</b> – up to {@value #CSV_MAX_ROWS} data rows (sample only)</li>
 *   <li><b>Parquet</b> – all rows, no limit (using Avro schema for the column types)</li>
 * </ul>
 *
 * Both writers are opened together in a try-with-resources so that partial
 * failures still close file handles cleanly.
 */
public final class DataExtractor {

    private static final Logger log = LoggerFactory.getLogger(DataExtractor.class);

    /** Maximum number of rows written to the CSV sample file. */
    static final int CSV_MAX_ROWS = 20;

    private DataExtractor() {}

    /**
     * Exports one table to CSV (≤ 20 rows) and Parquet (all rows).
     *
     * @param table      open Jackcess Table handle
     * @param avroSchema Avro record schema pre-built by {@link SchemaExtractor}
     * @param csvDir     target directory for the {@code .csv} file
     * @param parquetDir target directory for the {@code .parquet} file
     */
    public static void exportTable(
            Table table, Schema avroSchema, Path csvDir, Path parquetDir) throws IOException {

        String tableName = table.getName();
        List<? extends Column> columns = table.getColumns();

        // Safe filename: replaces any character that could be problematic on the host FS
        String safeFileName = tableName.replaceAll("[^a-zA-Z0-9_\\-]", "_");

        Path csvPath     = csvDir.resolve(safeFileName + ".csv");
        Path parquetPath = parquetDir.resolve(safeFileName + ".parquet");

        // Header array for CSV (original Access column names)
        String[] headers = columns.stream()
                .map(Column::getName)
                .toArray(String[]::new);

        // Sanitised field names for Avro/Parquet GenericRecord
        String[] avroFieldNames = columns.stream()
                .map(col -> TypeMapper.toAvroName(col.getName()))
                .toArray(String[]::new);

        // ── Hadoop configuration for local filesystem Parquet writes ──────────
        // RawLocalFileSystem (instead of LocalFileSystem) writes Parquet files
        // WITHOUT generating the hidden .filename.parquet.crc checksum sidecars
        // that LocalFileSystem creates by default.
        Configuration conf = new Configuration();
        conf.set("fs.defaultFS", "file:///");
        conf.set("fs.file.impl", org.apache.hadoop.fs.RawLocalFileSystem.class.getName());
        conf.set("fs.file.impl.disable.cache", "true");
        conf.set("io.native.lib.available", "false");

        org.apache.hadoop.fs.Path hadoopPath =
                new org.apache.hadoop.fs.Path(parquetPath.toUri().toString());

        CSVFormat csvFormat = CSVFormat.DEFAULT.builder()
                .setHeader(headers)
                .setRecordSeparator("\n")
                .build();

        int csvRowsWritten     = 0;
        int parquetRowsWritten = 0;

        // Open CSV writer + Parquet writer together; both are closed in reverse
        // order on any exit (normal or exceptional).
        try (BufferedWriter csvWriter      = Files.newBufferedWriter(csvPath);
             CSVPrinter     csvPrinter     = new CSVPrinter(csvWriter, csvFormat);
             ParquetWriter<GenericRecord> parquetWriter = AvroParquetWriter
                     .<GenericRecord>builder(hadoopPath)
                     .withSchema(avroSchema)
                     .withConf(conf)
                     .withCompressionCodec(CompressionCodecName.GZIP)
                     .withWriteMode(ParquetFileWriter.Mode.OVERWRITE)
                     .build()) {

            for (Row row : table) {

                // ── Parquet: ALWAYS write (no row limit) ──────────────────
                GenericRecord record = new GenericData.Record(avroSchema);
                for (int i = 0; i < columns.size(); i++) {
                    Column col = columns.get(i);
                    Object raw = row.get(col.getName());
                    record.put(avroFieldNames[i], TypeMapper.toAvroValue(raw, col.getType()));
                }
                parquetWriter.write(record);
                parquetRowsWritten++;

                // ── CSV: write only the first CSV_MAX_ROWS rows ───────────
                if (csvRowsWritten < CSV_MAX_ROWS) {
                    List<Object> values = new ArrayList<>(columns.size());
                    for (Column col : columns) {
                        Object val = row.get(col.getName());
                        values.add(val != null ? val.toString() : "");
                    }
                    csvPrinter.printRecord(values);
                    csvRowsWritten++;
                }
            }
        }

        log.info("  '{}': {} Parquet rows | {} CSV rows (limit {})",
                tableName, parquetRowsWritten, csvRowsWritten, CSV_MAX_ROWS);
    }
}
