package org.eba.migrator;

import com.healthmarketscience.jackcess.Database;
import com.healthmarketscience.jackcess.DatabaseBuilder;
import com.healthmarketscience.jackcess.Relationship;
import java.io.File;
import java.util.List;

public class TestRel {
    public static void main(String[] args) throws Exception {
        File f = new File("inp/eba_taxonomy3.2.accdb");
        try (Database db = DatabaseBuilder.open(f)) {
            List<Relationship> rels = db.getRelationships();
            for (Relationship rel : rels) {
                System.out.println(rel.getName() + " : " + rel.hasReferentialIntegrity());
            }
        }
    }
}
