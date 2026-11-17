package dev.evumi.honk.core

/**
 * The few SQLite operations [LocalStore] needs. The app implements it over
 * android.database.sqlite; the JVM tests over JDBC (sqlite-jdbc). Arguments
 * are Long, Int, Boolean (stored as 0/1), String or null.
 */
interface Sql {
    /** Runs one statement with no arguments and no result rows. */
    fun exec(sql: String)

    /** Runs one statement with arguments and no result rows. */
    fun run(sql: String, args: List<Any?> = emptyList())

    fun <T> query(sql: String, args: List<Any?> = emptyList(), map: (Row) -> T): List<T>

    /** Runs [body] in a write transaction (`BEGIN IMMEDIATE`), rolled back if it throws. Not nested. */
    fun <T> transaction(body: () -> T): T

    fun close()

    interface Row {
        fun long(i: Int): Long
        fun text(i: Int): String?
        fun isNull(i: Int): Boolean
    }
}

class StoreException(message: String, cause: Throwable? = null) : Exception(message, cause)
