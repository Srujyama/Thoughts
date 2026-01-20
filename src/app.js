export class ThoughtCollector {
  constructor(inputEl, buttonEl, listEl) {
    this.input = inputEl
    this.button = buttonEl
    this.list = listEl
    this.thoughts = this.loadThoughts()
    
    this.button.addEventListener('click', () => this.saveThought())
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        this.saveThought()
      }
    })
    
    this.render()
  }
  
  loadThoughts() {
    const saved = localStorage.getItem('thoughts')
    return saved ? JSON.parse(saved) : []
  }
  
  persistThoughts() {
    localStorage.setItem('thoughts', JSON.stringify(this.thoughts))
  }
  
  saveThought() {
    const text = this.input.value.trim()
    if (!text) return
    
    const thought = {
      id: Date.now(),
      text: text,
      timestamp: new Date().toISOString()
    }
    
    this.thoughts.unshift(thought)
    this.persistThoughts()
    this.input.value = ''
    this.render()
  }
  
  deleteThought(id) {
    this.thoughts = this.thoughts.filter(t => t.id !== id)
    this.persistThoughts()
    this.render()
  }
  
  formatDate(isoString) {
    const date = new Date(isoString)
    const now = new Date()
    const diffMs = now - date
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)
    
    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    
    return date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric',
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
    })
  }
  
  render() {
    if (this.thoughts.length === 0) {
      this.list.innerHTML = `
        <p class="empty-state">No thoughts yet. Start typing above.</p>
      `
      return
    }
    
    this.list.innerHTML = this.thoughts.map(thought => `
      <div class="thought-card" data-id="${thought.id}">
        <p class="thought-text">${this.escapeHtml(thought.text)}</p>
        <div class="thought-footer">
          <span class="thought-time">${this.formatDate(thought.timestamp)}</span>
          <button class="delete-btn" data-id="${thought.id}" title="Delete">×</button>
        </div>
      </div>
    `).join('')
    
    // Add delete handlers
    this.list.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = parseInt(e.target.dataset.id)
        this.deleteThought(id)
      })
    })
  }
  
  escapeHtml(text) {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML.replace(/\n/g, '<br>')
  }
}
