'use strict';

const escapeHtml=(value) => String(value ?? '').replace(/[&<>'"]/g,(character) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[character]));

fetch('/openapi.json').then((response) => {
  if (!response.ok) throw new Error('OpenAPI contract is unavailable');
  return response.json();
}).then((contract) => {
  document.querySelector('#apiDescription').textContent=contract.info.description;
  const endpoints=[]; for (const [path,operations] of Object.entries(contract.paths || {})) for (const [method,operation] of Object.entries(operations)) endpoints.push({ path,method:method.toUpperCase(),...operation });
  document.querySelector('#apiEndpointCount').textContent=String(endpoints.length);
  document.querySelector('#apiEndpoints').innerHTML=endpoints.map((endpoint) => `<article class="record-row api-endpoint"><div><strong><span class="status status-active">${escapeHtml(endpoint.method)}</span> ${escapeHtml(endpoint.path)}</strong><small>${escapeHtml(endpoint.summary || '')}</small></div><span>${escapeHtml((endpoint.tags || []).join(', '))}</span></article>`).join('');
}).catch((error) => { document.querySelector('#apiEndpoints').innerHTML=`<div class="resource-warning" role="alert">${escapeHtml(error.message)}</div>`; });
