import '../App.css'
import { Map } from '../map'
import { useEffect, useRef } from 'react'

let ready = false

export default function App() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current || ready) return
    ready = true
    new Map(ref.current)
  }, [ref])

  return (
    <div
      style={{ width: 'calc(100vw - 1px)', height: 'calc(100vh - 1px)' }}
      ref={ref}></div>
  )
}
