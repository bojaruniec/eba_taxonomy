package org.eba.migrator;

import com.healthmarketscience.jackcess.Database;
import com.healthmarketscience.jackcess.Relationship;
import org.apache.avro.Schema;
import org.apache.avro.SchemaBuilder;
import org.apache.avro.generic.GenericData;
import org.apache.avro.generic.GenericRecord;
import org.apache.hadoop.conf.Configuration;
import org.apache.parquet.avro.AvroParquetWriter;
import org.apache.parquet.hadoop.ParquetFileWriter;
import org.apache.parquet.hadoop.ParquetWriter;
import org.apache.parquet.hadoop.metadata.CompressionCodecName;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;

public final class RelationshipExtractor {

    private static final Logger log = LoggerFactory.getLogger(RelationshipExtractor.class);

    private RelationshipExtractor() {}

    /**
     * Extracts all relationships from the database and writes them directly to
     * a _ForeignKeys.parquet file.
     *
     * @param db         open Jackcess Database handle
     * @param parquetDir target directory for the .parquet file
     */
    public static void extractRelationships(Database db, Path parquetDir) throws IOException {
        Path parquetPath = parquetDir.resolve("_ForeignKeys.parquet");
        
        // Define Avro schema for the relationship records
        Schema avroSchema = SchemaBuilder.record("_ForeignKeys")
                .fields()
                .name("source_table").type().stringType().noDefault()
                .name("source_column").type().stringType().noDefault()
                .name("target_table").type().stringType().noDefault()
                .name("target_column").type().stringType().noDefault()
                .endRecord();

        Configuration conf = new Configuration();
        conf.set("fs.defaultFS", "file:///");
        conf.set("fs.file.impl", org.apache.hadoop.fs.RawLocalFileSystem.class.getName());
        conf.set("fs.file.impl.disable.cache", "true");
        conf.set("io.native.lib.available", "false");

        org.apache.hadoop.fs.Path hadoopPath = new org.apache.hadoop.fs.Path(parquetPath.toUri().toString());
        int count = 0;

        try (ParquetWriter<GenericRecord> writer = AvroParquetWriter
                .<GenericRecord>builder(hadoopPath)
                .withSchema(avroSchema)
                .withConf(conf)
                .withCompressionCodec(CompressionCodecName.GZIP)
                .withWriteMode(ParquetFileWriter.Mode.OVERWRITE)
                .build()) {

            List<Relationship> relationships = db.getRelationships();
            for (Relationship rel : relationships) {
                String fromTable = rel.getFromTable().getName();
                String toTable = rel.getToTable().getName();

                // Skip system tables
                if (fromTable.startsWith("~") || toTable.startsWith("~")) {
                    continue;
                }

                List<com.healthmarketscience.jackcess.Column> fromCols = rel.getFromColumns();
                List<com.healthmarketscience.jackcess.Column> toCols = rel.getToColumns();

                for (int i = 0; i < fromCols.size(); i++) {
                    String fromCol = fromCols.get(i).getName();
                    String toCol = toCols.get(i).getName();

                    GenericRecord record = new GenericData.Record(avroSchema);
                    record.put("source_table", fromTable);
                    record.put("source_column", fromCol);
                    record.put("target_table", toTable);
                    record.put("target_column", toCol);

                    writer.write(record);
                    count++;
                }
            }
        }

        log.info("Exported {} relationship columns to _ForeignKeys.parquet", count);
    }
}
