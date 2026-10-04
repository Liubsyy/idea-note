document.getElementById('slow-result').textContent = '资源已加载，脚本已执行';
parent.postMessage({ type: 'slow-preview-fixture', event: 'executed' }, '*');
setInterval(() => parent.postMessage({ type: 'slow-preview-fixture', event: 'heartbeat' }, '*'), 100);
