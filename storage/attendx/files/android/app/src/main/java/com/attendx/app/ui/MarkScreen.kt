package com.attendx.app.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.attendx.app.api.Api
import com.attendx.app.api.ApiException
import com.attendx.app.api.Session
import com.google.zxing.BinaryBitmap
import com.google.zxing.MultiFormatReader
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import java.nio.ByteBuffer
import kotlin.coroutines.resume

private fun permissionGranted(context: Context, permission: String): Boolean =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

private suspend fun currentLocation(context: Context): Location? = suspendCancellableCoroutine { cont ->
    val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val provider = if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) LocationManager.GPS_PROVIDER else LocationManager.NETWORK_PROVIDER
    val last = try { lm.getLastKnownLocation(provider) } catch (_: Exception) { null }
    if (last != null && System.currentTimeMillis() - last.time < 60_000) {
        cont.resume(last)
        return@suspendCancellableCoroutine
    }
    try {
        lm.requestSingleUpdate(provider, { loc -> if (!cont.isCancelled) cont.resume(loc) }, null)
    } catch (e: Exception) {
        cont.resume(last)
    }
}

private fun imageProxyToRGB(proxy: ImageProxy): IntArray? {
    val plane = proxy.planes[0]
    val buffer: ByteBuffer = plane.buffer
    val width = proxy.width
    val height = proxy.height
    val rowStride = plane.rowStride
    val pixelStride = plane.pixelStride
    val y = ByteArray(buffer.remaining())
    buffer.get(y)
    val rgb = IntArray(width * height)
    var idx = 0
    for (row in 0 until height) {
        for (col in 0 until width) {
            val yv = y[row * rowStride + col * pixelStride].toInt() and 0xFF
            rgb[idx++] = 0xFF000000.toInt() or (yv shl 16) or (yv shl 8) or yv
        }
    }
    return rgb
}

@Composable
fun MarkScreen(api: Api, session: Session, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()

    var cameraGranted by remember { mutableStateOf(permissionGranted(context, Manifest.permission.CAMERA)) }
    var locationGranted by remember { mutableStateOf(permissionGranted(context, Manifest.permission.ACCESS_FINE_LOCATION)) }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        cameraGranted = result[Manifest.permission.CAMERA] == true
        locationGranted = result[Manifest.permission.ACCESS_FINE_LOCATION] == true
    }

    var qrToken by remember { mutableStateOf<String?>(null) }
    var scanning by remember { mutableStateOf(true) }
    var location by remember { mutableStateOf<Location?>(null) }
    var selfieBase64 by remember { mutableStateOf<String?>(null) }
    var submitting by remember { mutableStateOf(false) }
    var verdict by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    var imageCapture by remember { mutableStateOf<ImageCapture?>(null) }

    val qrReader = remember { MultiFormatReader() }

    fun handleFrame(proxy: ImageProxy) {
        try {
            if (qrToken == null && scanning) {
                val rgb = imageProxyToRGB(proxy)
                if (rgb != null) {
                    val source = RGBLuminanceSource(proxy.width, proxy.height, rgb)
                    val bitmap = BinaryBitmap(HybridBinarizer(source))
                    val result = qrReader.decodeWithState(bitmap)
                    if (result != null && result.text.isNotBlank()) {
                        qrToken = result.text
                        scanning = false
                    }
                }
            }
        } catch (_: Exception) {
        } finally {
            proxy.close()
        }
    }

    fun captureSelfie() {
        val capture = imageCapture ?: return
        val file = File(context.cacheDir, "selfie_${System.currentTimeMillis()}.jpg")
        capture.takePicture(
            ImageCapture.OutputFileOptions.Builder(file).build(),
            ContextCompat.getMainExecutor(context),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                    scope.launch(Dispatchers.IO) {
                        try {
                            val bytes = file.readBytes()
                            val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                            selfieBase64 = "data:image/jpeg;base64,$b64"
                            file.delete()
                        } catch (e: Exception) {
                            error = e.message
                        }
                    }
                }
                override fun onError(exception: ImageCaptureException) {
                    error = exception.message ?: "Camera capture failed"
                }
            }
        )
    }

    fun submit() {
        scope.launch {
            submitting = true; error = null
            try {
                val loc = location
                if (loc == null) throw ApiException("Location not available — enable GPS and retry")
                val selfie = selfieBase64
                if (selfie == null) throw ApiException("Capture a live selfie first")
                val res = api.submitAttendance(qrToken ?: "", loc.latitude, loc.longitude, loc.accuracy, selfie)
                verdict = res.optString("verdict").ifEmpty { "Recorded" }
            } catch (e: ApiException) {
                error = e.message
            } catch (e: Exception) {
                error = "Could not reach the server"
            }
            submitting = false
        }
    }

    LaunchedEffect(Unit) {
        if (!cameraGranted || !locationGranted) {
            permissionLauncher.launch(arrayOf(Manifest.permission.CAMERA, Manifest.permission.ACCESS_FINE_LOCATION))
        }
        location = currentLocation(context)
    }

    Column(modifier = modifier.padding(16.dp)) {
        Text("Verify your presence", style = MaterialTheme.typography.headlineSmall)
        Text("Scan the session QR, allow GPS, and capture a live selfie.", style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(12.dp))

        verdict?.let {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("✓ $it", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.titleMedium)
                    TextButton(onClick = { qrToken = null; scanning = true; selfieBase64 = null; verdict = null; error = null }) {
                        Text("Mark another session")
                    }
                }
            }
            return@Column
        }

        if (qrToken == null) {
            if (!cameraGranted) {
                Text("Camera permission is required to scan the session QR.", color = MaterialTheme.colorScheme.error)
                Button(onClick = { permissionLauncher.launch(arrayOf(Manifest.permission.CAMERA)) }) { Text("Grant camera") }
            } else {
                Card(Modifier.fillMaxWidth().height(300.dp)) {
                    AndroidView(
                        factory = { ctx ->
                            PreviewView(ctx).also { previewView ->
                                val providerFuture = ProcessCameraProvider.getInstance(ctx)
                                providerFuture.addListener({
                                    val provider = providerFuture.get()
                                    val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
                                    val analysis = ImageAnalysis.Builder()
                                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                                        .build()
                                    analysis.setAnalyzer(ContextCompat.getMainExecutor(ctx)) { proxy -> handleFrame(proxy) }
                                    val capture = ImageCapture.Builder().build()
                                    imageCapture = capture
                                    try {
                                        provider.unbindAll()
                                        provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis, capture)
                                    } catch (_: Exception) {}
                                }, ContextCompat.getMainExecutor(ctx))
                            }
                        },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                Text("Point the camera at the session QR code shown by your faculty.", style = MaterialTheme.typography.bodySmall)
            }
        } else {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Text("QR captured ✓", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
                    Text(qrToken!!.take(48) + (if (qrToken!!.length > 48) "…" else ""), style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(10.dp))
                    Text(
                        if (location != null) "📍 GPS locked (${location!!.latitude}, ${location!!.longitude})" else "📍 Acquiring location…",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Spacer(Modifier.height(10.dp))
                    if (selfieBase64 == null) {
                        Button(onClick = { captureSelfie() }, modifier = Modifier.fillMaxWidth()) { Text("Capture live selfie") }
                    } else {
                        Text("Selfie captured ✓", color = MaterialTheme.colorScheme.primary)
                        Spacer(Modifier.height(10.dp))
                        Button(onClick = { submit() }, enabled = !submitting, modifier = Modifier.fillMaxWidth().height(46.dp)) {
                            if (submitting) CircularProgressIndicator(Modifier.width(20.dp).height(20.dp), strokeWidth = 2.dp)
                            else Text("Submit attendance")
                        }
                    }
                    error?.let {
                        Spacer(Modifier.height(8.dp))
                        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                    TextButton(onClick = { qrToken = null; scanning = true; selfieBase64 = null; error = null }) { Text("Rescan QR") }
                }
            }
        }
    }
}