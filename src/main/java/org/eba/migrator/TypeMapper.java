package org.eba.migrator;

import com.healthmarketscience.jackcess.Column;
import com.healthmarketscience.jackcess.DataType;
import org.apache.avro.Schema;
import org.apache.avro.SchemaBuilder;

import java.nio.ByteBuffer;

/**
 * Utility class that maps Jackcess {@link DataType} values to:
 *  - Standard SQL type strings (used for DDL generation)
 *  - Nullable Avro {@link Schema} objects (used for Parquet writing)
 *  - Avro-compatible Java values (used when building {@code GenericRecord}s)
 */
public final class TypeMapper {

    private TypeMapper() {}

    // ── SQL type mapping ────────────────────────────────────────────────────

    /**
     * Returns a standard SQL type string for the given Jackcess column.
     * VARCHAR length is derived from {@code column.getLengthInUnits()} (characters).
     */
    public static String toSqlType(Column column) {
        DataType dt = column.getType();
        switch (dt) {
            case TEXT: {
                int chars = column.getLengthInUnits();
                return "VARCHAR(" + (chars > 0 ? chars : 255) + ")";
            }
            case MEMO:
                return "TEXT";
            case BYTE:
                return "SMALLINT";
            case INT:
                return "SMALLINT";
            case LONG:
                return "INTEGER";
            case DOUBLE:
                return "DOUBLE PRECISION";
            case FLOAT:
                return "REAL";
            case BOOLEAN:
                return "BOOLEAN";
            case SHORT_DATE_TIME:
                return "TIMESTAMP";
            case MONEY:
                return "NUMERIC(19,4)";
            case NUMERIC: {
                byte prec  = column.getPrecision();
                byte scale = column.getScale();
                return "NUMERIC(" + (prec > 0 ? prec : 18) + "," + scale + ")";
            }
            case GUID:
                return "VARCHAR(38)";
            case BINARY:
            case OLE:
                return "BYTEA";
            case COMPLEX_TYPE:
                return "TEXT";
            default:
                return "TEXT";
        }
    }

    // ── Avro schema mapping ─────────────────────────────────────────────────

    /**
     * Returns a nullable Avro schema (i.e. {@code ["null", <type>]}) for the
     * given Jackcess DataType.  All fields are nullable to accommodate Access
     * tables where NOT NULL is not always enforced.
     */
    public static Schema toAvroFieldSchema(DataType dt) {
        switch (dt) {
            case TEXT:
            case MEMO:
            case GUID:
            case SHORT_DATE_TIME:
            case MONEY:
            case COMPLEX_TYPE:
                return SchemaBuilder.nullable().stringType();
            case BYTE:
            case INT:
            case LONG:
                return SchemaBuilder.nullable().intType();
            case DOUBLE:
            case NUMERIC:
                return SchemaBuilder.nullable().doubleType();
            case FLOAT:
                return SchemaBuilder.nullable().floatType();
            case BOOLEAN:
                return SchemaBuilder.nullable().booleanType();
            case BINARY:
            case OLE:
                return SchemaBuilder.nullable().bytesType();
            default:
                return SchemaBuilder.nullable().stringType();
        }
    }

    // ── Avro value conversion ───────────────────────────────────────────────

    /**
     * Converts a raw value returned by Jackcess into the Java type expected by
     * the Avro GenericData writer for the given DataType.
     */
    public static Object toAvroValue(Object raw, DataType dt) {
        if (raw == null) return null;
        try {
            switch (dt) {
                case TEXT:
                case MEMO:
                case GUID:
                case COMPLEX_TYPE:
                case SHORT_DATE_TIME:
                case MONEY:
                    return raw.toString();
                case BYTE:
                case INT:
                case LONG:
                    return ((Number) raw).intValue();
                case DOUBLE:
                case NUMERIC:
                    return ((Number) raw).doubleValue();
                case FLOAT:
                    return ((Number) raw).floatValue();
                case BOOLEAN:
                    return (raw instanceof Boolean) ? raw : Boolean.parseBoolean(raw.toString());
                case BINARY:
                case OLE:
                    return (raw instanceof byte[]) ? ByteBuffer.wrap((byte[]) raw) : null;
                default:
                    return raw.toString();
            }
        } catch (ClassCastException e) {
            // Fallback: convert anything to string rather than dropping the value
            return raw.toString();
        }
    }

    // ── Identifier sanitization ─────────────────────────────────────────────

    /**
     * Converts an arbitrary Access name into a valid Avro identifier
     * ({@code [A-Za-z_][A-Za-z0-9_]*}).  The original name is preserved in
     * the Avro field's {@code doc} attribute for round-tripping.
     */
    public static String toAvroName(String name) {
        if (name == null || name.isEmpty()) return "_unknown";
        String safe = name.replaceAll("[^A-Za-z0-9_]", "_");
        if (Character.isDigit(safe.charAt(0))) safe = "_" + safe;
        return safe;
    }
}