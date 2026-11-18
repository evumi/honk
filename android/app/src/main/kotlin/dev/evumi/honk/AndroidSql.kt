package dev.evumi.honk

import android.database.sqlite.SQLiteCursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteProgram
import dev.evumi.honk.core.Sql
import dev.evumi.honk.core.StoreException
import java.io.File

/**
 * [Sql] over android.database.sqlite. Arguments are bound with their types
 * (rawQuery would bind every argument as text).
 */
class AndroidSql(file: File) : Sql {
    private val db: SQLiteDatabase = SQLiteDatabase.openDatabase(
        file.path,
        null,
        SQLiteDatabase.CREATE_IF_NECESSARY or SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING,
    )

    override fun exec(sql: String) = db.execSQL(sql)

    override fun run(sql: String, args: List<Any?>) {
        db.compileStatement(sql).use { st ->
            bind(st, args)
            st.executeUpdateDelete()
        }
    }

    override fun <T> query(sql: String, args: List<Any?>, map: (Sql.Row) -> T): List<T> {
        val factory = SQLiteDatabase.CursorFactory { _, driver, editTable, query ->
            bind(query, args)
            SQLiteCursor(driver, editTable, query)
        }
        // editTable is non-null from API 35; it only matters for cursor updates, which this never makes.
        return db.rawQueryWithFactory(factory, sql, null, "").use { c ->
            val row = object : Sql.Row {
                override fun long(i: Int) = c.getLong(i)
                override fun text(i: Int): String? = if (c.isNull(i)) null else c.getString(i)
                override fun isNull(i: Int) = c.isNull(i)
            }
            buildList { while (c.moveToNext()) add(map(row)) }
        }
    }

    override fun <T> transaction(body: () -> T): T {
        db.beginTransaction()
        try {
            val v = body()
            db.setTransactionSuccessful()
            return v
        } finally {
            db.endTransaction()
        }
    }

    override fun close() = db.close()

    private fun bind(p: SQLiteProgram, args: List<Any?>) {
        args.forEachIndexed { i, a ->
            val idx = i + 1
            when (a) {
                null -> p.bindNull(idx)
                is Long -> p.bindLong(idx, a)
                is Int -> p.bindLong(idx, a.toLong())
                is Boolean -> p.bindLong(idx, if (a) 1 else 0)
                is String -> p.bindString(idx, a)
                else -> throw StoreException("unsupported argument $a")
            }
        }
    }
}
