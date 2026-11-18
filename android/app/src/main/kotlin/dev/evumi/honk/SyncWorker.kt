package dev.evumi.honk

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * A sync about every six hours (WorkManager decides exactly when, and skips
 * runs without a network): the same refresh as the app's "sync now", which
 * stores what the gateway queued, applies edits and deletes and removes the
 * notifications they made stale. It posts no notifications; a message that
 * arrived without its push shows in the app. The counterpart of the iOS
 * background refresh in ios/App/BackgroundRefresh.swift.
 */
class SyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        // refresh() does nothing until the device is registered and swallows its own failures.
        HonkService.get(applicationContext).refresh()
        return Result.success()
    }

    companion object {
        const val NAME = "honk-sync"
        const val INTERVAL_HOURS = 6L

        /** Schedules the periodic sync; an existing schedule is kept, so calling this on every start is fine. */
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<SyncWorker>(INTERVAL_HOURS, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
