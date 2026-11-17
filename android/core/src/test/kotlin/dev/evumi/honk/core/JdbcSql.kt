package dev.evumi.honk.core

import java.sql.Connection
import java.sql.DriverManager
import java.sql.PreparedStatement
import java.sql.ResultSet

/** [Sql] over sqlite-jdbc, for the JVM tests. */
class JdbcSql(path: String) : Sql {
    private val conn: Connection = DriverManager.getConnection("jdbc:sqlite:$path").apply { autoCommit = true }

    init {
        exec("PRAGMA journal_mode = WAL")
        exec("PRAGMA busy_timeout = 5000")
    }

    override fun exec(sql: String) {
        conn.createStatement().use { it.execute(sql) }
    }

    override fun run(sql: String, args: List<Any?>) {
        prepare(sql, args).use { it.executeUpdate() }
    }

    override fun <T> query(sql: String, args: List<Any?>, map: (Sql.Row) -> T): List<T> =
        prepare(sql, args).use { st ->
            st.executeQuery().use { rs ->
                val row = JdbcRow(rs)
                buildList { while (rs.next()) add(map(row)) }
            }
        }

    override fun <T> transaction(body: () -> T): T {
        exec("BEGIN IMMEDIATE")
        return try {
            body().also { exec("COMMIT") }
        } catch (e: Throwable) {
            runCatching { exec("ROLLBACK") }
            throw e
        }
    }

    override fun close() = conn.close()

    private fun prepare(sql: String, args: List<Any?>): PreparedStatement {
        val st = conn.prepareStatement(sql)
        args.forEachIndexed { i, a ->
            when (a) {
                null -> st.setNull(i + 1, java.sql.Types.NULL)
                is Long -> st.setLong(i + 1, a)
                is Int -> st.setLong(i + 1, a.toLong())
                is Boolean -> st.setLong(i + 1, if (a) 1 else 0)
                is String -> st.setString(i + 1, a)
                else -> throw StoreException("unsupported argument $a")
            }
        }
        return st
    }

    private class JdbcRow(private val rs: ResultSet) : Sql.Row {
        override fun long(i: Int) = rs.getLong(i + 1)
        override fun text(i: Int): String? = rs.getString(i + 1)
        override fun isNull(i: Int): Boolean {
            rs.getObject(i + 1)
            return rs.wasNull()
        }
    }
}
