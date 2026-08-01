<?php
// Reference only: keep this code in your own trusted server environment.
// Never expose the Worker token to a browser.
function ask_zico_proxy(string $workerBaseUrl, string $proxyToken, array $payload): array {
    $request = curl_init(rtrim($workerBaseUrl, '/') . '/api/assistant/message');
    curl_setopt_array($request, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            'x-assistant-proxy-token: ' . $proxyToken,
        ],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 20,
    ]);
    $body = curl_exec($request);
    $status = curl_getinfo($request, CURLINFO_RESPONSE_CODE);
    curl_close($request);
    if (!is_string($body) || $status < 200 || $status >= 300) {
        throw new RuntimeException('Assistant request failed.');
    }
    return json_decode($body, true, 512, JSON_THROW_ON_ERROR);
}
