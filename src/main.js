import './style.css'
import { ThoughtCollector } from './app.js'

document.querySelector('#app').innerHTML = `
  <div class="container">
    <h1>thoughts</h1>
    
    <div class="input-area">
      <textarea 
        id="thought-input" 
        placeholder="What's on your mind?"
        rows="3"
      ></textarea>
      <button id="save-btn" type="button">Save thought</button>
    </div>
    
    <div class="thoughts-list" id="thoughts-list">
      <!-- Thoughts will appear here -->
    </div>
  </div>
`

const collector = new ThoughtCollector(
  document.querySelector('#thought-input'),
  document.querySelector('#save-btn'),
  document.querySelector('#thoughts-list')
)
