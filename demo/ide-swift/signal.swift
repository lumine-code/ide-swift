func average(_ samples: [Double]) -> Double {
    samples.reduce(0, +) / Double(samples.count)
}

let samples = [0.2, 0.8, -0.4, 0.5, 1.0]
let amplitude: Double = "high"
print(average(samples), amplitude)
