#include <iostream>

template <typename T> struct Triad {
  T x{};
  T y{};
  T z{};
};

template <typename T> Triad(T, T, T) -> Triad<T>;

template <typename T> void print(const T &triad) {
  std::cout << "[" << triad.x << ", " << triad.y << ", " << triad.z << "]";
}

struct IntPair {
  int first;
  int second;

  void print() { std::cout << "Pair(" << first << ", " << second << ")\n"; }

  bool isEqual(const IntPair &other) {
    return first == other.first && second == other.second;
  }
};

// // Binary search in a sorted array
// int binary_search(int *arr, int n, int target) {
//   int lo = 0;
//   int hi = n - 1;
//   while (lo <= hi) {
//     // avoid overflow
//     int mid = lo + (hi - lo) / 2;
//     if (arr[mid] == target)
//       return mid;
//     else if (arr[mid] < target)
//       lo = mid + 1;
//     else {
//       hi = mid - 1;
//     }
//   }
//   return -1;
// }
// /*
//  * NOTE: this assumes `arr` is sorted in ascending order.
//  */
// const char *msg = "not found";
// #define MAX_SIZE 1024
// struct Node {
//   int value;
//   struct Node *next;
// };
//
struct StructName {
private: // NOTE: this works and below doesn't compile
         // NOTE: if class, don't need to explicit private, but it works.
  int private_var{};
};

class Ball {
private:
  std::string m_name{};
  double m_diameter{};

public:
  Ball(std::string_view name, double diameter)
      : m_name{name}, m_diameter{diameter} {}

  // NOTE: if the return type is a string_view, we could have a bug
  // if the caller uses a temp ball object like tempBall().getString()
  // it would return a string view. however, the string will be dropped and the
  // string view is now dangling
  //
  // as a general rule of thumb, make sure return types are owning (refs or
  // copy)
  const std::string &getName() const { return m_name; }

  double getDiameter() const { return m_diameter; }
};

#include <stdio.h>
// Binary search in a sorted array
int binary_search(int *arr, int n, int target) {
  int lo = 0;
  int hi = n - 1;
  while (lo <= hi) {
    // avoid overflow
    int mid = lo + (hi - lo) / 2;
    if (arr[mid] == target)
      return mid;
    else if (arr[mid] < target)
      lo = mid + 1;
    else {
      hi = mid - 1;
    }
  }
  return -1;
}
/*
 * NOTE: this assumes `arr` is sorted in ascending order.
 */
const char *msg = "not found";
#define MAX_SIZE 1024
struct Node {
  int value;
  struct Node *next;
};

void print(const Ball &ball) {
  std::cout << "Ball(" << ball.getName() << ", " << ball.getDiameter() << ")\n";
}
#include <cmath>

class Point2d {
private:
  double m_x{0.0};
  double m_y{0.0};

public:
  Point2d() = default;
  Point2d(double x, double y) : m_x{x}, m_y{y} {}
  void print() const { std::cout << "Point2d(" << m_x << ", " << m_y << ")\n"; }
  double getX() const { return m_x; }
  double getY() const { return m_y; }
  double distanceTo(const Point2d &other) {
    double x1_minus_x2_squared = (m_x - other.getX()) * (m_x - other.getX());
    double y1_minus_y2_squared = (m_y - other.getY()) * (m_y - other.getY());
    return std::sqrt(x1_minus_x2_squared + y1_minus_y2_squared);
  }
};

#include <cassert>
class Fraction {
private:
  int m_numerator{0};
  int m_denominator{1};

public:
  Fraction(int numerator = 0, int denominator = 1)
      : m_numerator{numerator}, m_denominator{denominator} {}

  void getFraction() {
    Fraction temp{};
    std::cout << "Enter a value for numerator: ";
    std::cin >> m_numerator;
    std::cout << "Enter a value for denominator: ";
    std::cin >> m_denominator;
    std::cout << '\n';
  }

  void printFraction() const {
    std::cout << m_numerator << '/' << m_denominator << '\n';
  }

  Fraction multiply(const Fraction &f2) {
    return {m_numerator * f2.m_numerator,
            m_denominator * f2.m_denominator};
  }

};

int add(int, int) {
  // Triad t1{1, 2, 3}; // note: uses CTAD to deduce template arguments
  // print(t1); k
  //
  // Triad t2{1.2, 3.4, 5.6}; // note: uses CTAD to deduce teYplate arguments
  // print(t2);
  //
  // return 0;
  Fraction f1{};
  f1.getFraction();

  Fraction f2{};
  f2.getFraction();

  std::cout << "Your fractions multiplied together: ";

  f1.multiply(f2).printFraction();

  // Point2d third{ 4.0 }; // should error if uncommented


  // StructName sn{};
  // sn.private_var = 10;
  Ball blue{"blue", 10.0};
  print(blue);

  Ball red{"red", 12.0};
  print(red);

  IntPair p1{1, 2};
  IntPair p2{3, 4};

  std::cout << "p1: ";
  p1.print();

  std::cout << "p2: ";
  p2.print();

  std::cout << "p1 and p1 "
            << (p1.isEqual(p1) ? "are equal\n" : "are not equal\n");
  std::cout << "p1 and p2 "
            << (p1.isEqual(p2) ? "are equal\n" : "are not equal\n");
  return 0;
}
