package org.eba.migrator;

import com.healthmarketscience.jackcess.Database;
import com.healthmarketscience.jackcess.DatabaseBuilder;
import com.healthmarketscience.jackcess.Table;
import com.healthmarketscience.jackcess.Row;
import com.healthmarketscience.jackcess.Column;
import java.io.File;

public class CheckOrderCol {
    public static void main(String[] args) throws Exception {
        File f = new File("inp/DPM2 Database_v 4_3_20260622.accdb");
        try (Database db = DatabaseBuilder.open(f)) {
            Table t = db.getTable("ModuleVersionComposition");
            Column orderCol = t.getColumn("Order");
            System.out.println("Jackcess Type for Order: " + orderCol.getType());
            
            System.out.println("Values for ModuleVID = 489:");
            for(Row row : t) {
                Integer modVid = row.getInt("ModuleVID");
                if (modVid != null && modVid == 489) {
                    System.out.println("RowGUID: " + row.get("RowGUID") + " | Raw Order Value: " + row.get("Order") + " | Class: " + (row.get("Order") == null ? "null" : row.get("Order").getClass().getName()));
                }
            }
        }
    }
}
