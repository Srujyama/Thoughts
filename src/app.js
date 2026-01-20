import { db } from './firebase.js'
import { 
  collection, 
  addDoc, 
  deleteDoc, 
  doc, 
  query, 
  orderBy, 
  onSnapshot 
} from 'firebase/firestore'

export class ThoughtCollector {
  constructor(inputEl, buttonEl, listEl) {
    this.input = inputEl
    this.button = buttonEl
    this.list = listEl
    this.thoughts = []
    this.thoughtsRef = collection(db, 'thoughts')
    
    this.button.addEventListener('click', () => this.saveThought())
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        this.saveThought()
      }
    })
    
    this.subscribe()
  }
  
  subscribe() {
    const q = query(this.thoughtsRef, orderBy('timestamp', 'desc'))
    
    onSnapshot(q, (snapshot) => {
      this.thoughts = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }))
      this.render()
    }, (error) => {
      console.error('Error fetching thoughts:', error)
      this.list.innerHTML = `<p class="error-state">Could not load thoughts. Check your connection.</p>`
    })
  }
  
  async saveThought() {
    const text = this.input.value.trim()
    if (!text) return
    
    this.button.disabled = true
    
    try {
      await addDoc(this.thoughtsRef, {
        text: text,
        timestamp: Date.now()
      })
      this.input.value = ''
    } catch (error) {
      console.error('Error saving thought:', error)
      alert('Could not save thought. Please try again.')
    } finally {
      this.button.disabled = false
    }
  }
  
  async deleteThought(id) {
    try {
      await deleteDoc(doc(db, 'thoughts', id))
    } catch (error) {
      console.error('Error deleting thought:', error)
      alert('Could not delete thought. Please try again.')
    }
  }
  
  formatDate(timestamp) {
    const date = new Date(timestamp)
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
    
    this.list.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.target.dataset.id
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
