package expo.modules.livespeech

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Base64
import androidx.core.os.bundleOf
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.math.log10
import kotlin.math.sqrt

class LiveSpeechModule : Module() {
  private val tag = "LiveSpeech"
  private val sampleRate = 16_000
  private val mainHandler = Handler(Looper.getMainLooper())
  private var socket: WebSocket? = null
  private var recorder: AudioRecord? = null
  @Volatile private var isCapturing = false
  @Volatile private var didStop = false
  @Volatile private var sessionReady = false
  @Volatile private var minSoundDb = -50.0
  private var lastLevelEventAt = 0L
  private var lastAboveThresholdAt = 0L

  override fun definition() = ModuleDefinition {
    Name("LiveSpeech")

    Events("onTranscript", "onState", "onAudioLevel")

    Function("start") { apiKey: String, endpoint: String, model: String, requestedMinSoundDb: Double ->
      if (apiKey.isBlank()) {
        throw IllegalArgumentException("请先填写百炼 API Key")
      }
      minSoundDb = requestedMinSoundDb.coerceIn(-70.0, -25.0)
      startRecognition(apiKey, endpoint, model)
    }

    Function("stop") {
      stopRecognition()
    }

    OnDestroy {
      stopRecognition()
    }
  }

  private fun startRecognition(apiKey: String, endpoint: String, model: String) {
    stopRecognition()
    didStop = false
    sessionReady = false
    sendState("connecting")

    val client = OkHttpClient.Builder()
      .pingInterval(20, TimeUnit.SECONDS)
      .build()
    val request = Request.Builder()
      .url(buildRealtimeUrl(endpoint, model))
      .header("Authorization", "Bearer $apiKey")
      .build()

    socket = client.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        Log.d(tag, "DashScope WebSocket connected")
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        handleServerMessage(text)
      }

      override fun onFailure(webSocket: WebSocket, throwable: Throwable, response: Response?) {
        if (!didStop) {
          sessionReady = true
          stopRecorder()
          val httpStatus = response?.let { "HTTP ${it.code} ${it.message}" }
          val details = listOfNotNull(httpStatus, throwable.message)
            .filter { it.isNotBlank() }
            .distinct()
            .joinToString(" · ")
          sendState("error", details.ifBlank { "无法连接到百炼实时识别服务" })
        }
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        stopRecorder()
        if (!didStop) sendState("idle")
      }
    })

    mainHandler.postDelayed({
      if (!didStop && !sessionReady) {
        sendState("error", "百炼连接成功，但 15 秒内未完成实时识别会话初始化")
        socket?.close(1000, "Task start timeout")
        socket = null
      }
    }, 15_000)
  }

  private fun handleServerMessage(message: String) {
    try {
      val root = JSONObject(message)
      when (root.optString("type")) {
        "session.created" -> {
          Log.d(tag, "DashScope realtime session created")
          sendSessionUpdate()
        }
        "session.updated" -> {
          sessionReady = true
          startRecorder()
        }
        "error" -> {
          sessionReady = true
          val error = dashScopeError(root)
          stopRecorder()
          sendState("error", error)
        }
        "conversation.item.input_audio_transcription.text" -> {
          val text = root.optString("text") + root.optString("stash")
          if (text.isNotBlank()) {
            sendEvent("onTranscript", bundleOf(
              "text" to text,
              "isFinal" to false
            ))
          }
        }
        "conversation.item.input_audio_transcription.completed" -> {
          val text = root.optString("transcript")
          if (text.isNotBlank()) {
            sendEvent("onTranscript", bundleOf("text" to text, "isFinal" to true))
          }
        }
        "conversation.item.input_audio_transcription.failed" -> {
          stopRecorder()
          sendState("error", dashScopeError(root))
        }
        "session.finished" -> {
          stopRecorder()
          socket?.close(1000, "Session finished")
          socket = null
          sendState("idle")
        }
        else -> {
          Log.d(tag, "Unhandled DashScope event: ${root.optString("type")}")
        }
      }
    } catch (error: Exception) {
      Log.w(tag, "Ignored unparsable recognition message", error)
    }
  }

  private fun startRecorder() {
    if (isCapturing || didStop) return
    val minBufferSize = AudioRecord.getMinBufferSize(
      sampleRate,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT
    )
    if (minBufferSize <= 0) {
      sendState("error", "这台设备不支持 16 kHz 单声道录音")
      return
    }

    try {
      recorder = AudioRecord(
        MediaRecorder.AudioSource.VOICE_RECOGNITION,
        sampleRate,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        minBufferSize * 2
      )
      recorder?.startRecording()
      isCapturing = true
      sendState("listening")

      thread(name = "LiveSpeechAudio", isDaemon = true) {
        val audio = ByteArray(maxOf(minBufferSize, 3_200))
        val silence = ByteArray(audio.size)
        while (isCapturing && !didStop) {
          val read = recorder?.read(audio, 0, audio.size, AudioRecord.READ_BLOCKING) ?: break
          if (read > 0) {
            val db = calculateDb(audio, read)
            val now = System.currentTimeMillis()
            val isAboveThreshold = db >= minSoundDb
            if (isAboveThreshold) lastAboveThresholdAt = now
            if (now - lastLevelEventAt >= 80) {
              lastLevelEventAt = now
              val level = ((db + 70.0) / 70.0).coerceIn(0.0, 1.0)
              sendEvent("onAudioLevel", bundleOf(
                "level" to level,
                "db" to db,
                "isAboveThreshold" to isAboveThreshold
              ))
            }

            // A short hangover preserves word beginnings/endings while replacing persistent
            // low-level room noise with digital silence for the server-side VAD.
            val source = if (isAboveThreshold || now - lastAboveThresholdAt < 250) audio else silence
            val audioBase64 = Base64.encodeToString(source, 0, read, Base64.NO_WRAP)
            socket?.send(JSONObject()
              .put("event_id", "audio-${System.nanoTime()}")
              .put("type", "input_audio_buffer.append")
              .put("audio", audioBase64)
              .toString())
          }
        }
      }
    } catch (error: SecurityException) {
      sendState("error", "请允许麦克风权限后再开始")
    } catch (error: Exception) {
      sendState("error", error.message ?: "麦克风启动失败")
    }
  }

  private fun stopRecognition() {
    didStop = true
    stopRecorder()
    socket?.let { activeSocket ->
      activeSocket.send(JSONObject()
        .put("event_id", "finish-${System.currentTimeMillis()}")
        .put("type", "session.finish")
        .toString())
      mainHandler.postDelayed({
        activeSocket.close(1000, "Stopped by user")
      }, 1_500)
    }
    socket = null
    sendState("idle")
  }

  private fun buildRealtimeUrl(endpoint: String, model: String): String {
    var url = endpoint.trim().trimEnd('/')
      .replace("/api-ws/v1/inference", "/api-ws/v1/realtime")
    if (!url.contains("/api-ws/v1/realtime")) {
      url = "${url}/api-ws/v1/realtime"
    }
    if (!Regex("(^|[?&])model=").containsMatchIn(url)) {
      url += if (url.contains("?")) "&" else "?"
      url += "model=${Uri.encode(model)}"
    }
    return url
  }

  private fun sendSessionUpdate() {
    // Qwen-ASR Realtime API initializes the session before microphone capture starts.
    socket?.send(JSONObject()
      .put("event_id", "session-${System.currentTimeMillis()}")
      .put("type", "session.update")
      .put("session", JSONObject()
        .put("input_audio_format", "pcm")
        .put("sample_rate", sampleRate)
        .put("input_audio_transcription", JSONObject().put("language", "zh"))
        .put("turn_detection", JSONObject()
          .put("type", "server_vad")
          .put("threshold", 0.0)
          .put("silence_duration_ms", 400)))
      .toString())
  }

  private fun stopRecorder() {
    isCapturing = false
    try {
      recorder?.stop()
    } catch (_: IllegalStateException) {
      // AudioRecord was not started.
    }
    recorder?.release()
    recorder = null
    sendEvent("onAudioLevel", bundleOf(
      "level" to 0.0,
      "db" to -70.0,
      "isAboveThreshold" to false
    ))
  }

  private fun calculateDb(audio: ByteArray, byteCount: Int): Double {
    var sumSquares = 0.0
    var samples = 0
    var index = 0
    while (index + 1 < byteCount) {
      val low = audio[index].toInt() and 0xFF
      val high = audio[index + 1].toInt()
      val sample = (high shl 8) or low
      sumSquares += sample.toDouble() * sample.toDouble()
      samples += 1
      index += 2
    }
    if (samples == 0) return -70.0
    val rms = sqrt(sumSquares / samples)
    if (rms < 1.0) return -70.0
    return (20.0 * log10(rms / 32768.0)).coerceIn(-70.0, 0.0)
  }

  private fun sendState(state: String, message: String? = null) {
    val event = bundleOf("state" to state)
    if (!message.isNullOrBlank()) event.putString("message", message)
    sendEvent("onState", event)
  }

  private fun dashScopeError(root: JSONObject): String {
    val nestedError = root.optJSONObject("error")
    val message = firstMeaningful(
      nestedError?.optString("message"),
      root.optString("message")
    ) ?: "百炼未能启动实时识别任务"
    val code = firstMeaningful(
      nestedError?.optString("code")
    )
    return if (code.isNullOrBlank()) message else "$message（$code）"
  }

  private fun firstMeaningful(vararg values: String?): String? =
    values.firstOrNull { !it.isNullOrBlank() }
}
