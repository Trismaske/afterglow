package expo.modules.mediastoreactions

import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MediaStoreActionsModule : Module() {
  private lateinit var launcher: AppContextActivityResultLauncher<MediaStoreActionInput, Boolean>

  override fun definition() = ModuleDefinition {
    Name("MediaStoreActions")

    RegisterActivityContracts {
      launcher = registerForActivityResult(MediaStoreActionContract(this@MediaStoreActionsModule))
    }

    AsyncFunction("trash") Coroutine { uris: List<Uri> ->
      launch(uris, MediaStoreAction.TRASH, true)
    }

    AsyncFunction("setFavourite") Coroutine { uris: List<Uri>, value: Boolean ->
      launch(uris, MediaStoreAction.FAVOURITE, value)
    }

    AsyncFunction("isFavourite") Coroutine { uri: Uri ->
      queryFlag(uri, MediaStore.MediaColumns.IS_FAVORITE)
    }

    AsyncFunction("isTrashed") Coroutine { uri: Uri ->
      queryFlag(uri, MediaStore.MediaColumns.IS_TRASHED)
    }
  }

  private suspend fun launch(
    uris: List<Uri>,
    action: MediaStoreAction,
    value: Boolean,
  ): Map<String, String> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      return mapOf("status" to "unsupported")
    }
    if (uris.isEmpty()) {
      return mapOf("status" to "applied")
    }
    val approved = launcher.launch(MediaStoreActionInput(uris, action, value))
    return mapOf("status" to if (approved) "applied" else "cancelled")
  }

  private fun queryFlag(uri: Uri, column: String): Boolean? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
    val resolver = appContext.reactContext?.contentResolver ?: return null
    return resolver.query(uri, arrayOf(column), null, null, null)?.use { cursor ->
      if (!cursor.moveToFirst()) return@use null
      val index = cursor.getColumnIndex(column)
      if (index < 0) null else cursor.getInt(index) != 0
    }
  }
}
